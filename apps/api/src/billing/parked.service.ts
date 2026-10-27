import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import type { AuthUser, ParkCartInput, ParkedCartDto, ParkedLine } from "@stello/shared";
import { fromPaise, lineTotalPaise } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

type ParkedRow = Prisma.ParkedCartGetPayload<object>;

/**
 * Held ("parked") carts, stored server-side so any terminal at the outlet can
 * resume them. Resuming is a claim: the row is deleted atomically, so two
 * terminals racing for the same cart get it exactly once.
 */
@Injectable()
export class ParkedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async list(user: AuthUser, outletId: string): Promise<ParkedCartDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.parkedCart.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { createdAt: "asc" },
    });
    return this.toDtos(user.tenantId, rows);
  }

  async park(user: AuthUser, outletId: string, input: ParkCartInput): Promise<ParkedCartDto> {
    this.assertOutlet(user, outletId);
    if (input.tableId) {
      const table = await this.prisma.diningTable.findFirst({ where: { id: input.tableId, tenantId: user.tenantId, outletId } });
      if (!table) throw new BadRequestException("Table not found in this outlet");
    }
    if (input.orderId) {
      const order = await this.prisma.order.findFirst({ where: { id: input.orderId, tenantId: user.tenantId, outletId } });
      if (!order || order.status !== "OPEN") throw new BadRequestException("That bill is no longer open");
      if (order.splitCount || order.parentOrderId) throw new BadRequestException("A split bill cannot take new items");
    }
    const amountPaise = input.lines.reduce((s, l) => s + lineTotalPaise(l.unitPrice, l.quantity), 0);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.parkedCart.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          label: input.label,
          orderType: input.orderType,
          tableId: input.tableId ?? null,
          orderId: input.orderId ?? null,
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          lines: input.lines as unknown as Prisma.InputJsonValue,
          itemCount: input.lines.reduce((s, l) => s + l.quantity, 0),
          amount: fromPaise(amountPaise),
          parkedById: user.id,
        },
      });
      await tx.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: "ORDER_PARKED", entity: "parked_cart", entityId: created.id, data: { label: input.label, orderId: input.orderId ?? null } },
      });
      return created;
    });
    this.realtime.notifyOutlet(outletId);
    return (await this.toDtos(user.tenantId, [row]))[0];
  }

  /** Claim a parked cart for this terminal (deletes it); 409 if another terminal won. */
  async resume(user: AuthUser, id: string): Promise<ParkedCartDto> {
    return this.claim(user, id, "ORDER_RESUMED");
  }

  async discard(user: AuthUser, id: string): Promise<{ ok: true }> {
    await this.claim(user, id, "ORDER_PARK_DISCARDED");
    return { ok: true };
  }

  private async claim(user: AuthUser, id: string, action: string): Promise<ParkedCartDto> {
    const row = await this.prisma.parkedCart.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!row) throw new ConflictException("That parked order was already resumed or discarded");
    this.assertOutlet(user, row.outletId);
    const dto = (await this.toDtos(user.tenantId, [row]))[0];
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.parkedCart.deleteMany({ where: { id, tenantId: user.tenantId } });
      if (claimed.count !== 1) throw new ConflictException("That parked order was already resumed or discarded");
      await tx.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action, entity: "parked_cart", entityId: id, data: { label: row.label } },
      });
    });
    this.realtime.notifyOutlet(row.outletId);
    return dto;
  }

  private async toDtos(tenantId: string, rows: ParkedRow[]): Promise<ParkedCartDto[]> {
    const tableIds = [...new Set(rows.map((r) => r.tableId).filter((t): t is string => !!t))];
    const userIds = [...new Set(rows.map((r) => r.parkedById).filter((u): u is string => !!u))];
    const [tables, users] = await Promise.all([
      tableIds.length ? this.prisma.diningTable.findMany({ where: { id: { in: tableIds }, tenantId }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds }, tenantId }, select: { id: true, name: true } }) : [],
    ]);
    const tableName = new Map(tables.map((t) => [t.id, t.name]));
    const userName = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      orderType: r.orderType as ParkedCartDto["orderType"],
      tableId: r.tableId,
      tableName: r.tableId ? (tableName.get(r.tableId) ?? null) : null,
      orderId: r.orderId,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      lines: r.lines as unknown as ParkedLine[],
      itemCount: r.itemCount,
      amount: Number(r.amount),
      parkedBy: r.parkedById ? (userName.get(r.parkedById) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
