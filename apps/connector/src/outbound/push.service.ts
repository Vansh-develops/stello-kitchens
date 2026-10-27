import { BadRequestException, Injectable, Logger, NotImplementedException } from "@nestjs/common";
import { MainApiService } from "../main-api.service";
import { UrbanPiperClient, type UpResult } from "./urbanpiper.client";
import { ondcCatalog, ondcOnStatus } from "./ondc";

export interface PushResult {
  platform: string;
  ok: boolean;
  simulated: boolean;
  referenceId?: string | null;
  detail?: unknown;
}

const DIRECT_GATED =
  "Direct Zomato/Swiggy APIs need partner onboarding — route this outlet through UrbanPiper (platform 'urbanpiper') instead";

/**
 * Outbound aggregator sync. UrbanPiper is the live path (menu, item and store
 * availability, order status); ONDC payloads are built to the public protocol
 * but sending them needs a registered ONDC subscriber, so they are returned for
 * inspection; direct Zomato/Swiggy are partner-gated.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly mainApi: MainApiService,
    private readonly up: UrbanPiperClient,
  ) {}

  private result(platform: string, r: UpResult, detail?: unknown): PushResult {
    return { platform, ok: r.ok, simulated: !!r.simulated, referenceId: r.referenceId ?? null, detail: detail ?? r.message };
  }

  async menu(platform: string, outletId: string): Promise<PushResult> {
    if (platform !== "URBANPIPER" && platform !== "ONDC") throw new NotImplementedException(DIRECT_GATED);
    const items = await this.mainApi.catalog(platform, outletId);
    if (platform === "URBANPIPER") return this.result(platform, await this.up.pushMenu(outletId, items), { items: items.length });
    if (platform === "ONDC") {
      const payload = ondcCatalog({ id: outletId, name: items[0]?.outletName ?? outletId, locationId: `${outletId}-L1` }, items);
      this.logger.log(`[ONDC] catalogue built (${items.length} items) — served on /on_search once ONDC onboarding is complete`);
      return { platform, ok: true, simulated: true, detail: payload };
    }
    throw new NotImplementedException(DIRECT_GATED);
  }

  /** Item availability. Explicit toggles, or a full resync from the catalogue's stock flags. */
  async stock(platform: string, outletId: string, toggles?: { externalId: string; available: boolean }[]): Promise<PushResult> {
    if (platform !== "URBANPIPER") {
      if (platform === "ONDC") return { platform, ok: true, simulated: true, detail: "ONDC availability is served via the catalogue (quantity.available)" };
      throw new NotImplementedException(DIRECT_GATED);
    }
    const list = toggles ?? (await this.mainApi.catalog(platform, outletId)).map((i) => ({ externalId: i.externalId, available: i.inStock }));
    const on = list.filter((t) => t.available).map((t) => t.externalId);
    const off = list.filter((t) => !t.available).map((t) => t.externalId);
    const [a, b] = await Promise.all([this.up.setItemsAvailable(outletId, on, true), this.up.setItemsAvailable(outletId, off, false)]);
    return { platform, ok: a.ok && b.ok, simulated: !!(a.simulated || b.simulated), referenceId: b.referenceId ?? a.referenceId ?? null, detail: { enabled: on, disabled: off } };
  }

  async store(platform: string, outletId: string, online: boolean, reason?: string): Promise<PushResult> {
    if (platform !== "URBANPIPER") {
      if (platform === "ONDC") return { platform, ok: true, simulated: true, detail: "ONDC store timings/availability are part of the catalogue" };
      throw new NotImplementedException(DIRECT_GATED);
    }
    return this.result(platform, await this.up.setStoreOnline(outletId, online, reason));
  }

  async orderStatus(platform: string, externalOrderId: string, status: string, prepTimeMins?: number): Promise<PushResult> {
    if (!externalOrderId) throw new BadRequestException("externalOrderId is required");
    if (platform === "URBANPIPER") return this.result(platform, await this.up.updateOrderStatus(externalOrderId, status, { prepTimeMins }));
    if (platform === "ONDC") {
      const message = ondcOnStatus(externalOrderId, status);
      return { platform, ok: true, simulated: true, detail: message ?? `no ONDC state for ${status}` };
    }
    throw new NotImplementedException(DIRECT_GATED);
  }
}
