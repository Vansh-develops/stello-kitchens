import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  AuthUser,
  EdgeActivateInput,
  EdgeActivationDto,
  EdgeConflictDto,
  EdgeConflictKind,
  EdgeDeviceDto,
  EdgeSeriesRowDto,
  EdgeStaffPinRowDto,
} from "@stello/shared";
import { edgeSeriesCode } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { formatDeviceToken } from "./edge-device.guard";
import { hashPin, newDeviceSecret, sha256 } from "./pin";

@Injectable()
export class EdgeAdminService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }
  private can(user: AuthUser, perm: string) {
    return user.permissions.includes("*") || user.permissions.includes(perm);
  }

  /**
   * Activate an edge terminal for offline billing. Binds to a provisioned
   * terminal (id or deviceToken, i.e. EDGE_DEVICE_ID) — or registers a new POS
   * terminal when the caller may manage devices — and issues a fresh device
   * secret plus a NEW invoice series. Re-activating the same terminal (e.g. after
   * its disk was wiped) never reuses a series, so a device that restarts its
   * counter at 1 can't collide with numbers it issued before. Earlier
   * activations of that terminal are revoked.
   */
  async activate(user: AuthUser, outletId: string, input: EdgeActivateInput): Promise<EdgeActivationDto> {
    this.assertOutlet(user, outletId);
    let terminal = input.terminalRef
      ? await this.prisma.terminal.findFirst({
          where: { tenantId: user.tenantId, outletId, OR: [{ id: input.terminalRef }, { deviceToken: input.terminalRef }] },
        })
      : null;
    if (input.terminalRef && !terminal) throw new NotFoundException("Terminal is not registered for this outlet");
    if (terminal && !terminal.isActive) throw new BadRequestException("Terminal is deactivated");
    if (terminal && terminal.type !== "POS") throw new BadRequestException("Only POS terminals can bill offline");
    if (!terminal) {
      if (!this.can(user, "devices.manage")) throw new ForbiddenException("Registering a new terminal needs devices.manage");
      terminal = await this.prisma.terminal.create({
        data: { tenantId: user.tenantId, outletId, name: input.name ?? "Edge POS", type: "POS", config: {} },
      });
    }

    const secret = newDeviceSecret();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const device = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM outlets WHERE id = ${outletId} FOR UPDATE`;
          const count = await tx.edgeDevice.count({ where: { tenantId: user.tenantId, outletId } });
          await tx.edgeDevice.updateMany({
            where: { tenantId: user.tenantId, terminalId: terminal!.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          const created = await tx.edgeDevice.create({
            data: {
              tenantId: user.tenantId,
              outletId,
              terminalId: terminal!.id,
              seriesCode: edgeSeriesCode(count + 1 + attempt),
              secretHash: sha256(secret),
              activatedById: user.id,
            },
          });
          await tx.auditLog.create({
            data: {
              tenantId: user.tenantId,
              userId: user.id,
              action: "EDGE_DEVICE_ACTIVATED",
              entity: "terminal",
              entityId: terminal!.id,
              data: { edgeDeviceId: created.id, seriesCode: created.seriesCode },
            },
          });
          return created;
        });
        return {
          edgeDeviceId: device.id,
          terminalId: terminal.id,
          outletId,
          deviceToken: formatDeviceToken(device.id, secret),
          seriesCode: device.seriesCode,
          serverTime: new Date().toISOString(),
        };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
    throw new BadRequestException("Could not allocate an invoice series; retry");
  }

  async devices(user: AuthUser, outletId: string): Promise<EdgeDeviceDto[]> {
    this.assertOutlet(user, outletId);
    const [devices, terminals, open] = await Promise.all([
      this.prisma.edgeDevice.findMany({ where: { tenantId: user.tenantId, outletId }, orderBy: { activatedAt: "desc" } }),
      this.prisma.terminal.findMany({ where: { tenantId: user.tenantId, outletId }, select: { id: true, name: true } }),
      this.prisma.edgeSyncConflict.groupBy({
        by: ["edgeDeviceId"],
        where: { tenantId: user.tenantId, outletId, status: "OPEN" },
        _count: { _all: true },
      }),
    ]);
    const names = new Map(terminals.map((t) => [t.id, t.name]));
    const openBy = new Map(open.map((o) => [o.edgeDeviceId, o._count._all]));
    return devices.map((d) => ({
      id: d.id,
      terminalId: d.terminalId,
      terminalName: names.get(d.terminalId) ?? "(removed terminal)",
      seriesCode: d.seriesCode,
      activatedAt: d.activatedAt.toISOString(),
      lastPushAt: d.lastPushAt?.toISOString() ?? null,
      lastPullAt: d.lastPullAt?.toISOString() ?? null,
      clockSkewMs: d.clockSkewMs,
      revokedAt: d.revokedAt?.toISOString() ?? null,
      openConflicts: openBy.get(d.id) ?? 0,
    }));
  }

  async revoke(user: AuthUser, outletId: string, id: string) {
    this.assertOutlet(user, outletId);
    const device = await this.prisma.edgeDevice.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!device) throw new NotFoundException("Edge device not found");
    await this.prisma.edgeDevice.update({ where: { id: device.id }, data: { revokedAt: device.revokedAt ?? new Date() } });
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "EDGE_DEVICE_REVOKED", entity: "terminal", entityId: device.terminalId, data: { edgeDeviceId: id } },
    });
    return { id, revoked: true };
  }

  // ---------- staff PINs ----------

  async staff(user: AuthUser, outletId: string): Promise<EdgeStaffPinRowDto[]> {
    this.assertOutlet(user, outletId);
    const users = await this.prisma.user.findMany({
      where: { tenantId: user.tenantId, isActive: true, userOutlets: { some: { outletId } } },
      include: { role: true },
      orderBy: { name: "asc" },
    });
    const pins = await this.prisma.edgeStaffPin.findMany({ where: { tenantId: user.tenantId, userId: { in: users.map((u) => u.id) } } });
    const pinBy = new Map(pins.map((p) => [p.userId, p]));
    return users.map((u) => ({
      userId: u.id,
      name: u.name,
      roleName: u.role.name,
      hasPin: pinBy.has(u.id),
      pinUpdatedAt: pinBy.get(u.id)?.updatedAt.toISOString() ?? null,
    }));
  }

  private async requireStaff(user: AuthUser, outletId: string, userId: string) {
    this.assertOutlet(user, outletId);
    const target = await this.prisma.user.findFirst({ where: { id: userId, tenantId: user.tenantId, userOutlets: { some: { outletId } } } });
    if (!target) throw new NotFoundException("Staff member not found in this outlet");
    return target;
  }

  async setPin(user: AuthUser, outletId: string, userId: string, pin: string) {
    await this.requireStaff(user, outletId, userId);
    const pinHash = hashPin(pin);
    await this.prisma.edgeStaffPin.upsert({
      where: { userId },
      create: { tenantId: user.tenantId, userId, pinHash, setById: user.id },
      update: { pinHash, setById: user.id },
    });
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "EDGE_PIN_SET", entity: "user", entityId: userId },
    });
    return { userId, hasPin: true };
  }

  async clearPin(user: AuthUser, outletId: string, userId: string) {
    await this.requireStaff(user, outletId, userId);
    await this.prisma.edgeStaffPin.deleteMany({ where: { tenantId: user.tenantId, userId } });
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "EDGE_PIN_CLEARED", entity: "user", entityId: userId },
    });
    return { userId, hasPin: false };
  }

  // ---------- conflicts + invoice series ----------

  async conflicts(user: AuthUser, outletId: string, status?: string): Promise<EdgeConflictDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.edgeSyncConflict.findMany({
      where: { tenantId: user.tenantId, outletId, ...(status === "OPEN" || status === "RESOLVED" ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const devices = await this.prisma.edgeDevice.findMany({
      where: { tenantId: user.tenantId, id: { in: [...new Set(rows.map((r) => r.edgeDeviceId))] } },
      select: { id: true, seriesCode: true },
    });
    const series = new Map(devices.map((d) => [d.id, d.seriesCode]));
    return rows.map((r) => ({
      id: r.id,
      edgeDeviceId: r.edgeDeviceId,
      seriesCode: series.get(r.edgeDeviceId) ?? null,
      clientId: r.clientId,
      orderId: r.orderId,
      billNumber: r.billNumber,
      kind: r.kind as EdgeConflictKind,
      message: r.message,
      detail: r.detail,
      status: r.status as "OPEN" | "RESOLVED",
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionNote: r.resolutionNote,
    }));
  }

  async resolve(user: AuthUser, outletId: string, id: string, note: string) {
    this.assertOutlet(user, outletId);
    const res = await this.prisma.edgeSyncConflict.updateMany({
      where: { id, tenantId: user.tenantId, outletId, status: "OPEN" },
      data: { status: "RESOLVED", resolvedById: user.id, resolvedAt: new Date(), resolutionNote: note },
    });
    if (!res.count) throw new NotFoundException("Open conflict not found");
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "EDGE_CONFLICT_RESOLVED", entity: "edge_sync_conflict", entityId: id, data: { note } },
    });
    return { id, status: "RESOLVED" };
  }

  /** Per device-series and fiscal year: how many invoices synced and which numbers are missing. */
  async series(user: AuthUser, outletId: string): Promise<EdgeSeriesRowDto[]> {
    this.assertOutlet(user, outletId);
    const groups = await this.prisma.edgeInvoiceSeq.groupBy({
      by: ["edgeDeviceId", "seriesCode", "fiscalYear"],
      where: { tenantId: user.tenantId, outletId },
      _count: { _all: true },
      _min: { seq: true },
      _max: { seq: true },
      orderBy: [{ seriesCode: "asc" }, { fiscalYear: "asc" }],
    });
    const out: EdgeSeriesRowDto[] = [];
    for (const g of groups) {
      const first = g._min.seq ?? 0;
      const last = g._max.seq ?? 0;
      const missing: number[] = [];
      // Series start at 1, so numbers below the first synced one are gaps too.
      if (g._count._all < last) {
        const seqs = await this.prisma.edgeInvoiceSeq.findMany({
          where: { tenantId: user.tenantId, edgeDeviceId: g.edgeDeviceId, fiscalYear: g.fiscalYear },
          select: { seq: true },
        });
        const have = new Set(seqs.map((s) => s.seq));
        for (let n = 1; n <= last && missing.length < 50; n++) if (!have.has(n)) missing.push(n);
      }
      out.push({ edgeDeviceId: g.edgeDeviceId, seriesCode: g.seriesCode, fiscalYear: g.fiscalYear, count: g._count._all, firstSeq: first, lastSeq: last, missing });
    }
    return out;
  }
}
