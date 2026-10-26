import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser, ServerCallDto, ServerCallStatus, ServerCallType } from "@stello/shared";
import type { ServerCall } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { FohEvents } from "./foh-events";

const ACTIVE: ServerCallStatus[] = ["OPEN", "ACKNOWLEDGED"];

/**
 * "Call a server": a diner (table QR) or staff member raises a WAITER / WATER /
 * BILL call for a table. Lifecycle OPEN → ACKNOWLEDGED → RESOLVED (OPEN may be
 * resolved directly). Transitions are conditional updates, so two staff tapping
 * "On my way" at once yield exactly one acknowledgement.
 */
@Injectable()
export class ServerCallsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: FohEvents,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  /** Public diner path: resolve the table from its QR token (no auth, no tenant context). */
  async callFromTable(tableToken: string, type: ServerCallType): Promise<{ tableName: string; callId: string }> {
    const table = await runUnscoped(() => this.prisma.diningTable.findUnique({ where: { publicToken: tableToken } }));
    if (!table) throw new NotFoundException("This QR code is no longer active");
    const call = await runUnscoped(() => this.raise(table.tenantId, table.outletId, table.id, type, "DINER", null));
    return { tableName: table.name, callId: call.id };
  }

  /** Staff-raised call (e.g. the captain requesting the bill for a table). */
  async callByStaff(user: AuthUser, outletId: string, tableId: string, type: ServerCallType): Promise<ServerCallDto> {
    this.assertOutlet(user, outletId);
    const table = await this.prisma.diningTable.findFirst({ where: { id: tableId, tenantId: user.tenantId, outletId } });
    if (!table) throw new NotFoundException("Table not found");
    const call = await this.raise(user.tenantId, outletId, table.id, type, "STAFF", user.id);
    return this.toDto(user.tenantId, outletId, call);
  }

  /**
   * Create a call unless the same table already has an unresolved call of the
   * same type (a diner tapping repeatedly must not spam the floor). The table
   * row lock serialises concurrent taps so the de-duplication is race-free.
   */
  private async raise(
    tenantId: string,
    outletId: string,
    tableId: string,
    type: ServerCallType,
    source: "DINER" | "STAFF",
    userId: string | null,
  ): Promise<ServerCall> {
    const { call, created } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dining_tables WHERE id = ${tableId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const existing = await tx.serverCall.findFirst({
        where: { tenantId, outletId, tableId, type, status: { in: ACTIVE } },
      });
      if (existing) return { call: existing, created: false };
      const call = await tx.serverCall.create({
        data: { tenantId, outletId, tableId, type, source, createdById: userId },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          action: type === "WAITER" ? "WAITER_CALLED" : `SERVER_CALL_${type}`,
          entity: "dining_table",
          entityId: tableId,
          data: { callId: call.id, type, source },
        },
      });
      return { call, created: true };
    });
    if (created) this.events.call(outletId, await this.toDto(tenantId, outletId, call));
    return call;
  }

  async list(user: AuthUser, outletId: string, includeResolved = false): Promise<ServerCallDto[]> {
    this.assertOutlet(user, outletId);
    const since = new Date(Date.now() - 12 * 3600_000);
    const calls = await this.prisma.serverCall.findMany({
      where: {
        tenantId: user.tenantId,
        outletId,
        ...(includeResolved ? { createdAt: { gte: since } } : { status: { in: ACTIVE } }),
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return this.toDtos(user.tenantId, outletId, calls);
  }

  acknowledge(user: AuthUser, outletId: string, id: string) {
    return this.transition(user, outletId, id, ["OPEN"], "ACKNOWLEDGED");
  }

  resolve(user: AuthUser, outletId: string, id: string) {
    return this.transition(user, outletId, id, ACTIVE, "RESOLVED");
  }

  private async transition(
    user: AuthUser,
    outletId: string,
    id: string,
    from: ServerCallStatus[],
    to: ServerCallStatus,
  ): Promise<ServerCallDto> {
    this.assertOutlet(user, outletId);
    const now = new Date();
    const res = await this.prisma.serverCall.updateMany({
      where: { id, tenantId: user.tenantId, outletId, status: { in: from } },
      data:
        to === "ACKNOWLEDGED"
          ? { status: to, acknowledgedAt: now, acknowledgedById: user.id }
          : { status: to, resolvedAt: now, resolvedById: user.id },
    });
    const call = await this.prisma.serverCall.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!call) throw new NotFoundException("Call not found");
    if (res.count === 0) throw new BadRequestException(`Call is already ${call.status.toLowerCase()}`);
    const dto = await this.toDto(user.tenantId, outletId, call);
    this.events.call(outletId, dto);
    return dto;
  }

  /** Resolve every open BILL call for a table (used once the bill is handled). */
  async resolveBillCalls(tenantId: string, outletId: string, tableId: string, userId: string | null) {
    await this.prisma.serverCall.updateMany({
      where: { tenantId, outletId, tableId, type: "BILL", status: { in: ACTIVE } },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: userId },
    });
  }

  private async toDto(tenantId: string, outletId: string, call: ServerCall): Promise<ServerCallDto> {
    return (await this.toDtos(tenantId, outletId, [call]))[0];
  }

  private async toDtos(tenantId: string, outletId: string, calls: ServerCall[]): Promise<ServerCallDto[]> {
    if (calls.length === 0) return [];
    const tableIds = [...new Set(calls.map((c) => c.tableId))];
    const [tables, assignments] = await Promise.all([
      this.prisma.diningTable.findMany({ where: { tenantId, outletId, id: { in: tableIds } }, select: { id: true, name: true, areaId: true } }),
      this.prisma.waiterAssignment.findMany({ where: { tenantId, outletId } }),
    ]);
    const userIds = [...new Set(calls.map((c) => c.acknowledgedById).filter((x): x is string => !!x))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const tableMap = new Map(tables.map((t) => [t.id, t]));
    const userMap = new Map(users.map((u) => [u.id, u.name]));
    return calls.map((c) => {
      const table = tableMap.get(c.tableId);
      const assigned = assignments
        .filter((a) => a.tableId === c.tableId || (a.areaId && a.areaId === table?.areaId))
        .map((a) => a.userId);
      return {
        id: c.id,
        tableId: c.tableId,
        tableName: table?.name ?? "Table",
        areaId: table?.areaId ?? null,
        type: c.type as ServerCallType,
        source: c.source as "DINER" | "STAFF",
        status: c.status as ServerCallStatus,
        createdAt: c.createdAt.toISOString(),
        acknowledgedAt: c.acknowledgedAt?.toISOString() ?? null,
        acknowledgedBy: c.acknowledgedById ? (userMap.get(c.acknowledgedById) ?? null) : null,
        resolvedAt: c.resolvedAt?.toISOString() ?? null,
        assignedUserIds: [...new Set(assigned)],
      };
    });
  }
}
