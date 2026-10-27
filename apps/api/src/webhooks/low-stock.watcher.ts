import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { domainEvents, emitDomainEvent, type DomainEvent } from "../events/domain-events";

/**
 * Turns stock movements into `stock.low` events. After anything that depletes
 * stock (orders firing KOTs, wastage) it re-checks the outlet's materials that
 * have a reorder level and emits once per material when it crosses to or below
 * that level; the latch re-arms when stock recovers. The latch is in memory, so
 * a restart may re-announce a material that is still low (at-least-once).
 */
@Injectable()
export class LowStockWatcher implements OnModuleInit, OnModuleDestroy {
  private readonly announced = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.unsubscribe = domainEvents.subscribe((e) => this.onEvent(e));
  }

  onModuleDestroy() {
    this.unsubscribe?.();
  }

  async onEvent(event: DomainEvent): Promise<void> {
    if ((event.type !== "order.created" && event.type !== "stock.changed") || !event.outletId) return;
    const materials = await runUnscoped(() =>
      this.prisma.rawMaterial.findMany({
        where: { tenantId: event.tenantId, outletId: event.outletId!, deletedAt: null, reorderLevel: { gt: 0 } },
        select: { id: true, name: true, unit: true, stockQty: true, reorderLevel: true },
      }),
    );
    for (const m of materials) {
      const low = Number(m.stockQty) <= Number(m.reorderLevel);
      if (!low) {
        this.announced.delete(m.id);
        continue;
      }
      if (this.announced.has(m.id)) continue;
      this.announced.add(m.id);
      emitDomainEvent("stock.low", event.tenantId, event.outletId, {
        rawMaterialId: m.id,
        name: m.name,
        unit: m.unit,
        stockQty: Number(m.stockQty),
        reorderLevel: Number(m.reorderLevel),
      });
    }
  }
}
