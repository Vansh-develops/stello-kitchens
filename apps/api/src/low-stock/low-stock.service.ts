import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { AuthUser, LowStockAlertDto, LowStockEvent, LowStockRecipient } from "@stello/shared";
import { Prisma, type LowStockAlert } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { runUnscoped } from "../common/tenant-context";
import { MessagingService } from "../messaging/messaging.service";
import { startJobLoop } from "../integrations/job-loop";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * Low-stock alerts. A material "crosses" when its running balance falls to or
 * below its reorder level. The crossing is recorded by flipping
 * `low_stock_states.isLow` false → true in one conditional upsert, so exactly
 * one caller (across concurrent sweeps and API replicas) raises the alert; the
 * flag re-arms when stock is replenished above the level.
 *
 * Evaluation runs right after any committed outlet change (the realtime
 * post-commit signal every stock path already fires) and on a periodic sweep.
 */
@Injectable()
export class LowStockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LowStockService.name);
  private stopJob: () => void = () => undefined;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly messaging: MessagingService,
  ) {}

  onModuleInit() {
    this.realtime.onOutletChanged?.((outletId) => this.schedule(outletId));
    this.stopJob = startJobLoop("low-stock-sweep", Number(process.env.LOW_STOCK_SWEEP_INTERVAL_MS ?? 60_000), () => this.evaluate());
  }
  onModuleDestroy() {
    this.stopJob();
    for (const t of this.pending.values()) clearTimeout(t);
  }

  /** Debounce bursts (a KOT depletes many materials) into one evaluation per outlet. */
  private schedule(outletId: string) {
    if (this.pending.has(outletId)) return;
    const t = setTimeout(() => {
      this.pending.delete(outletId);
      void runUnscoped(() => this.evaluate(outletId)).catch((e) => this.logger.warn(`low-stock check ${outletId}: ${(e as Error).message}`));
    }, 750);
    t.unref?.();
    this.pending.set(outletId, t);
  }

  /** Evaluate one outlet (or all). Returns the alerts raised by this call. */
  async evaluate(outletId?: string): Promise<LowStockAlert[]> {
    return runUnscoped(async () => {
      const outletFilter = outletId ? Prisma.sql`AND m."outletId" = ${outletId}` : Prisma.empty;
      // Re-arm materials that were replenished above their level.
      await this.prisma.$executeRaw`
        UPDATE low_stock_states s SET "isLow" = false
        FROM raw_materials m
        WHERE s."rawMaterialId" = m.id AND s."isLow" = true
          AND (m."stockQty" > m."reorderLevel" OR m."deletedAt" IS NOT NULL) ${outletFilter}`;
      // Candidates: at/below level and not already flagged.
      const low = await this.prisma.$queryRaw<{ id: string; tenantId: string; outletId: string; name: string; unit: string; stockQty: Prisma.Decimal; reorderLevel: Prisma.Decimal }[]>`
        SELECT m.id, m."tenantId", m."outletId", m.name, m.unit, m."stockQty", m."reorderLevel"
        FROM raw_materials m
        LEFT JOIN low_stock_states s ON s."rawMaterialId" = m.id
        WHERE m."deletedAt" IS NULL AND m."reorderLevel" > 0 AND m."stockQty" <= m."reorderLevel"
          AND (s.id IS NULL OR s."isLow" = false) ${outletFilter}`;
      const raised: LowStockAlert[] = [];
      for (const m of low) {
        // The conditional upsert is the dedupe: only the caller that flips the flag gets a row back.
        const flipped = await this.prisma.$queryRaw<{ id: string }[]>`
          INSERT INTO low_stock_states (id, "tenantId", "outletId", "rawMaterialId", "isLow", "lastAlertAt")
          VALUES (${`lss_${m.id}`}, ${m.tenantId}, ${m.outletId}, ${m.id}, true, now())
          ON CONFLICT ("rawMaterialId") DO UPDATE SET "isLow" = true, "lastAlertAt" = now()
          WHERE low_stock_states."isLow" = false
          RETURNING id`;
        if (!flipped.length) continue;
        raised.push(await this.raise(m));
      }
      return raised;
    });
  }

  private async raise(m: { id: string; tenantId: string; outletId: string; name: string; unit: string; stockQty: Prisma.Decimal; reorderLevel: Prisma.Decimal }) {
    const [outlet, cfg] = await Promise.all([
      this.prisma.outlet.findUnique({ where: { id: m.outletId } }),
      this.prisma.messagingConfig.findUnique({ where: { tenantId: m.tenantId } }),
    ]);
    const qty = N(m.stockQty);
    const level = N(m.reorderLevel);
    const vars = [m.name, `${fmt(qty)} ${m.unit}`, `${fmt(level)} ${m.unit}`, outlet?.name ?? ""];
    const body = `Low stock at ${vars[3]}: ${m.name} is down to ${vars[1]} (reorder level ${vars[2]}).`;

    let notified = 0;
    const recipients = cfg && cfg.lowStockEnabled ? ((cfg.lowStockRecipients as LowStockRecipient[] | null) ?? []) : [];
    for (const r of recipients) {
      for (const channel of r.channels) {
        const to = channel === "EMAIL" ? r.email : r.phone;
        if (!to) continue;
        await this.messaging.enqueue({ tenantId: m.tenantId, outletId: m.outletId, purpose: "LOW_STOCK", channel, to, body, vars });
        notified++;
      }
    }
    const alert = await this.prisma.lowStockAlert.create({
      data: { tenantId: m.tenantId, outletId: m.outletId, rawMaterialId: m.id, materialName: m.name, stockQty: m.stockQty, reorderLevel: m.reorderLevel, unit: m.unit, notified },
    });
    const event: LowStockEvent = { ...this.toDto(alert), outletId: m.outletId };
    this.realtime.server?.to(`outlet:${m.outletId}`).emit("inventory:low-stock", event);
    return alert;
  }

  // ---------- Staff ----------

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async list(user: AuthUser, outletId: string): Promise<LowStockAlertDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.lowStockAlert.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((r) => this.toDto(r));
  }

  async acknowledge(user: AuthUser, outletId: string, id: string) {
    this.assertOutlet(user, outletId);
    const row = await this.prisma.lowStockAlert.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!row) throw new NotFoundException("Alert not found");
    await this.prisma.lowStockAlert.update({ where: { id }, data: { acknowledgedAt: row.acknowledgedAt ?? new Date() } });
    return { id };
  }

  async checkNow(user: AuthUser, outletId: string) {
    this.assertOutlet(user, outletId);
    const raised = await this.evaluate(outletId);
    return { raised: raised.length };
  }

  private toDto(a: LowStockAlert): LowStockAlertDto {
    return {
      id: a.id,
      rawMaterialId: a.rawMaterialId,
      materialName: a.materialName,
      stockQty: N(a.stockQty),
      reorderLevel: N(a.reorderLevel),
      unit: a.unit,
      notified: a.notified,
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    };
  }
}
