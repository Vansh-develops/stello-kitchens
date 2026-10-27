import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type {
  AggregatorCatalogItemDto,
  AggregatorOrderActionInput,
  AggregatorSyncLogDto,
  AuthUser,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { runUnscoped } from "../common/tenant-context";

// Aggregator platform → the sales-channel name that carries its pricing/maps.
const PLATFORM_CHANNEL: Record<string, string> = { ZOMATO: "Zomato", SWIGGY: "Swiggy", ONDC: "ONDC", URBANPIPER: "UrbanPiper" };

type Kind = "MENU" | "ITEM_STOCK" | "STORE" | "ORDER_STATUS";
interface PushResult {
  ok: boolean;
  simulated?: boolean;
  referenceId?: string | null;
  detail?: unknown;
}

/**
 * Main-API side of outbound aggregator sync. Staff actions (menu push, item
 * availability, store on/off, order accept/ready/dispatch) are relayed to the
 * connector deployable, which talks to UrbanPiper/ONDC; every call is logged in
 * aggregator_sync_logs. Item 86/un-86 changes are pushed automatically after
 * the post-commit outlet signal (diffed against the last pushed state).
 */
@Injectable()
export class AggregatorSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AggregatorSyncService.name);
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit() {
    if (process.env.AGGREGATOR_AUTO_STOCK_SYNC === "off") return;
    this.realtime.onOutletChanged?.((outletId) => this.scheduleStockSync(outletId));
  }
  onModuleDestroy() {
    for (const t of this.pending.values()) clearTimeout(t);
  }

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  /** Relay to the connector (`/push/:platform/...`) with the service key. */
  async connector(platform: string, action: "menu" | "stock" | "store" | "order-status", body: Record<string, unknown>): Promise<PushResult> {
    const base = process.env.CONNECTOR_URL ?? "http://localhost:3003";
    const key = process.env.CONNECTOR_KEY ?? (process.env.NODE_ENV === "production" ? "" : "dev-connector-key");
    const res = await fetch(`${base}/push/${platform.toLowerCase()}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-connector-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text };
    }
    if (!res.ok) throw new Error(String(json.message ?? `connector HTTP ${res.status}`));
    return json as unknown as PushResult;
  }

  private async run(tenantId: string, outletId: string, platform: string, kind: Kind, fn: () => Promise<PushResult>) {
    try {
      const r = await fn();
      await this.prisma.aggregatorSyncLog.create({
        data: {
          tenantId,
          outletId,
          platform,
          kind,
          status: r.simulated ? "SIMULATED" : "OK",
          referenceId: r.referenceId ?? null,
          detail: (r.detail ?? null) as Prisma.InputJsonValue,
        },
      });
      return r;
    } catch (e) {
      const error = (e as Error).message.slice(0, 300);
      await this.prisma.aggregatorSyncLog.create({ data: { tenantId, outletId, platform, kind, status: "ERROR", error } });
      throw new BadRequestException(`${platform} ${kind.toLowerCase().replace("_", " ")} failed: ${error}`);
    }
  }

  // ---------- Staff actions ----------

  pushMenu(user: AuthUser, outletId: string, platform: string) {
    this.assertOutlet(user, outletId);
    return this.run(user.tenantId, outletId, platform, "MENU", () => this.connector(platform, "menu", { outletId }));
  }

  pushStock(user: AuthUser, outletId: string, platform: string) {
    this.assertOutlet(user, outletId);
    return this.run(user.tenantId, outletId, platform, "ITEM_STOCK", () => this.connector(platform, "stock", { outletId }));
  }

  setStore(user: AuthUser, outletId: string, platform: string, online: boolean, reason?: string) {
    this.assertOutlet(user, outletId);
    return this.run(user.tenantId, outletId, platform, "STORE", () => this.connector(platform, "store", { outletId, online, reason }));
  }

  /** Accept / ready / dispatched / reject: record locally, then call back the platform. */
  async orderAction(user: AuthUser, outletId: string, aggregatorOrderId: string, input: AggregatorOrderActionInput) {
    this.assertOutlet(user, outletId);
    const agg = await this.prisma.aggregatorOrder.findFirst({ where: { id: aggregatorOrderId, tenantId: user.tenantId, outletId } });
    if (!agg) throw new NotFoundException("Aggregator order not found");
    if (["DELIVERED", "REJECTED", "CANCELLED"].includes(agg.status)) throw new BadRequestException(`Order is already ${agg.status.toLowerCase()}`);
    const result = await this.run(user.tenantId, outletId, agg.platform, "ORDER_STATUS", () =>
      this.connector(agg.platform, "order-status", { externalOrderId: agg.externalOrderId, status: input.status, prepTimeMins: input.prepTimeMins }),
    );
    // Only after the platform accepted the transition does our copy move.
    await this.prisma.aggregatorOrder.update({ where: { id: agg.id }, data: { status: input.status } });
    return { id: agg.id, status: input.status, simulated: !!result.simulated };
  }

  async syncLog(user: AuthUser, outletId: string): Promise<AggregatorSyncLogDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.aggregatorSyncLog.findMany({ where: { tenantId: user.tenantId, outletId }, orderBy: { createdAt: "desc" }, take: 50 });
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      kind: r.kind as AggregatorSyncLogDto["kind"],
      status: r.status as AggregatorSyncLogDto["status"],
      referenceId: r.referenceId,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ---------- Connector-facing catalogue ----------

  async catalog(platform: string, outletId: string): Promise<AggregatorCatalogItemDto[]> {
    return runUnscoped(async () => {
      const outlet = await this.prisma.outlet.findUnique({ where: { id: outletId } });
      if (!outlet) throw new NotFoundException("Unknown outlet");
      const channel = await this.prisma.channel.findFirst({ where: { outletId, name: PLATFORM_CHANNEL[platform] } });
      if (!channel) throw new BadRequestException(`No ${platform} channel configured for this outlet`);
      const maps = await this.prisma.aggregatorMenuMap.findMany({
        where: { channelId: channel.id },
        include: { item: { include: { category: true, channelPrices: { where: { channelId: channel.id } } } } },
      });
      return maps
        .filter((m) => m.item.deletedAt === null)
        .map((m) => ({
          externalId: m.externalId,
          title: m.item.name,
          description: null,
          price: m.item.channelPrices[0] ? Number(m.item.channelPrices[0].price) : Number(m.item.price),
          inStock: m.item.inStock,
          isVeg: m.item.isVeg,
          categoryRef: m.item.categoryId,
          categoryName: m.item.category.name,
          outletName: outlet.name,
        }));
    });
  }

  // ---------- Automatic availability sync ----------

  private scheduleStockSync(outletId: string) {
    if (this.pending.has(outletId)) return;
    const t = setTimeout(() => {
      this.pending.delete(outletId);
      void runUnscoped(() => this.autoStockSync(outletId)).catch((e) => this.logger.warn(`auto stock sync ${outletId}: ${(e as Error).message}`));
    }, 3_000);
    t.unref?.();
    this.pending.set(outletId, t);
  }

  /** Push only items whose availability changed since the last successful push. */
  async autoStockSync(outletId: string): Promise<number> {
    const outlet = await this.prisma.outlet.findUnique({ where: { id: outletId } });
    const channel = await this.prisma.channel.findFirst({ where: { outletId, name: PLATFORM_CHANNEL.URBANPIPER, isActive: true } });
    if (!outlet || !channel) return 0;
    const items = await this.catalog("URBANPIPER", outletId);
    const last = await this.prisma.aggregatorSyncLog.findFirst({
      where: { outletId, platform: "URBANPIPER", kind: "ITEM_STOCK", status: { in: ["OK", "SIMULATED"] } },
      orderBy: { createdAt: "desc" },
    });
    const prevOff = new Set(((last?.detail as { disabled?: string[] } | null)?.disabled ?? []) as string[]);
    const prevOn = new Set(((last?.detail as { enabled?: string[] } | null)?.enabled ?? []) as string[]);
    const changed = items.filter((i) => (i.inStock ? !prevOn.has(i.externalId) : !prevOff.has(i.externalId)));
    if (!changed.length) return 0;
    await this.run(outlet.tenantId, outletId, "URBANPIPER", "ITEM_STOCK", async () => {
      const r = await this.connector("URBANPIPER", "stock", { outletId, items: changed.map((i) => ({ externalId: i.externalId, available: i.inStock })) });
      // Record the full current state so the next diff is against reality.
      return { ...r, detail: { enabled: items.filter((i) => i.inStock).map((i) => i.externalId), disabled: items.filter((i) => !i.inStock).map((i) => i.externalId) } };
    }).catch(() => undefined);
    return changed.length;
  }
}
