import { Logger } from "@nestjs/common";

/**
 * Outbound UrbanPiper (Atlas / POS-partner API) calls — the real integration for
 * Zomato/Swiggy/etc. without direct partner onboarding. Endpoints and payloads
 * follow api-docs.urbanpiper.com/downstream:
 *  - Auth: `Authorization: apikey <username>:<api_key>` + `X-UPR-Biz-Id: <biz_id>`
 *  - Menu:   POST /external/api/v1/inventory/locations/{location_ref_id}/
 *  - Items:  POST /hub/api/v1/items/      { location_ref_id, item_ref_ids, action }
 *  - Store:  POST /hub/api/v1/location/   { location_ref_id, platforms, action }
 *  - Orders: PUT  /external/api/v1/orders/{id}/status/ { new_status, message, extra }
 * Menu/item/store actions are processed asynchronously by UrbanPiper; the
 * response carries a `reference_id` echoed in the later callback webhook.
 */
export interface UrbanPiperConfig {
  baseUrl: string;
  username: string;
  apiKey: string;
  bizId: string;
  platforms: string[]; // e.g. ["zomato", "swiggy"]
}

export function urbanPiperConfigFromEnv(env = process.env): UrbanPiperConfig | null {
  if (!env.URBANPIPER_API_USERNAME || !env.URBANPIPER_API_KEY || !env.URBANPIPER_BIZ_ID) return null;
  return {
    baseUrl: env.URBANPIPER_BASE_URL ?? "https://pos-int.urbanpiper.com",
    username: env.URBANPIPER_API_USERNAME,
    apiKey: env.URBANPIPER_API_KEY,
    bizId: env.URBANPIPER_BIZ_ID,
    platforms: (env.URBANPIPER_PLATFORMS ?? "zomato,swiggy").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export interface CatalogItem {
  externalId: string; // our item's ref id on the platform (aggregator_menu_maps.externalId)
  title: string;
  description?: string | null;
  price: number;
  inStock: boolean;
  isVeg: boolean;
  categoryRef: string;
  categoryName: string;
  sortOrder?: number;
}

export type UpOrderStatus = "Acknowledged" | "Food Ready" | "Dispatched" | "Completed" | "Cancelled";

/** Our aggregator order status → UrbanPiper's `new_status` (null = nothing to send). */
export function toUrbanPiperStatus(status: string): UpOrderStatus | null {
  switch (status) {
    case "ACCEPTED":
      return "Acknowledged";
    case "READY":
      return "Food Ready";
    case "PICKED_UP":
      return "Dispatched";
    case "DELIVERED":
      return "Completed";
    case "REJECTED":
    case "CANCELLED":
      return "Cancelled";
    default:
      return null; // RECEIVED / PREPARING have no UrbanPiper equivalent
  }
}

/** Build the catalogue payload: categories first, then items referencing them. */
export function urbanPiperMenuPayload(items: CatalogItem[]) {
  const categories = new Map<string, { ref_id: string; name: string; sort_order: number; active: boolean }>();
  for (const i of items) {
    if (!categories.has(i.categoryRef)) {
      categories.set(i.categoryRef, { ref_id: i.categoryRef, name: i.categoryName, sort_order: categories.size + 1, active: true });
    }
  }
  return {
    flush_categories: false,
    categories: [...categories.values()],
    flush_items: false,
    items: items.map((i, idx) => ({
      ref_id: i.externalId,
      title: i.title,
      description: i.description ?? "",
      available: i.inStock,
      sold_at_store: true,
      sort_order: i.sortOrder ?? idx,
      price: Math.round(i.price * 100) / 100,
      current_stock: -1, // unlimited; availability is driven by item actions
      food_type: i.isVeg ? "1" : "2", // 1 veg · 2 non-veg · 3 egg
      category_ref_ids: [i.categoryRef],
      fulfillment_modes: ["delivery", "pickup"],
    })),
  };
}

export interface UpResult {
  ok: boolean;
  referenceId?: string | null;
  message?: string;
  simulated?: boolean;
}

export class UrbanPiperError extends Error {
  constructor(readonly status: number | null, message: string, readonly body?: unknown) {
    super(`urbanpiper: ${message}`);
  }
}

export class UrbanPiperClient {
  private readonly logger = new Logger("UrbanPiper");
  constructor(private readonly cfg: UrbanPiperConfig | null) {}

  get live(): boolean {
    return !!this.cfg;
  }

  private async call(method: "POST" | "PUT", path: string, body: unknown): Promise<Record<string, unknown>> {
    if (!this.cfg) throw new Error("UrbanPiper is not configured");
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `apikey ${this.cfg.username}:${this.cfg.apiKey}`,
          "X-UPR-Biz-Id": this.cfg.bizId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new UrbanPiperError(null, `request failed: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text };
    }
    if (!res.ok) {
      // Re-sending the status an order is already in is a success (idempotent).
      if (json.err_code === "err_order_already_in_status") return { status: "success", message: "already in status" };
      throw new UrbanPiperError(res.status, `HTTP ${res.status} ${String(json.message ?? text).slice(0, 200)}`, json);
    }
    if (json.status && json.status !== "success") throw new UrbanPiperError(res.status, String(json.message ?? "rejected"), json);
    return json;
  }

  private simulated(what: string): UpResult {
    this.logger.log(`${what} (simulated — set URBANPIPER_API_USERNAME/KEY/BIZ_ID to send)`);
    return { ok: true, simulated: true, referenceId: null };
  }

  async pushMenu(locationRefId: string, items: CatalogItem[]): Promise<UpResult> {
    if (!this.cfg) return this.simulated(`menu ${locationRefId}: ${items.length} items`);
    const r = await this.call("POST", `/external/api/v1/inventory/locations/${encodeURIComponent(locationRefId)}/`, urbanPiperMenuPayload(items));
    return { ok: true, referenceId: (r.reference as string) ?? (r.reference_id as string) ?? null, message: r.message as string };
  }

  async setItemsAvailable(locationRefId: string, itemRefIds: string[], available: boolean): Promise<UpResult> {
    if (!itemRefIds.length) return { ok: true, referenceId: null };
    if (!this.cfg) return this.simulated(`items ${available ? "enable" : "disable"} ${itemRefIds.join(",")}`);
    const r = await this.call("POST", "/hub/api/v1/items/", {
      location_ref_id: locationRefId,
      item_ref_ids: itemRefIds,
      action: available ? "enable" : "disable",
    });
    return { ok: true, referenceId: (r.reference_id as string) ?? null, message: r.message as string };
  }

  async setStoreOnline(locationRefId: string, online: boolean, reason?: string): Promise<UpResult> {
    if (!this.cfg) return this.simulated(`store ${locationRefId} ${online ? "enable" : "disable"}`);
    const r = await this.call("POST", "/hub/api/v1/location/", {
      location_ref_id: locationRefId,
      platforms: this.cfg.platforms,
      action: online ? "enable" : "disable",
      ...(!online && reason ? { reason } : {}),
    });
    return { ok: true, referenceId: (r.reference_id as string) ?? null, message: r.message as string };
  }

  async updateOrderStatus(upOrderId: string, status: string, opts: { message?: string; prepTimeMins?: number; reasonCode?: string } = {}): Promise<UpResult> {
    const newStatus = toUrbanPiperStatus(status);
    if (!newStatus) return { ok: true, message: `no UrbanPiper status for ${status}` };
    if (!this.cfg) return this.simulated(`order ${upOrderId} → ${newStatus}`);
    const r = await this.call("PUT", `/external/api/v1/orders/${encodeURIComponent(upOrderId)}/status/`, {
      new_status: newStatus,
      message: opts.message ?? `Order ${newStatus.toLowerCase()} by restaurant`,
      ...(newStatus === "Cancelled" ? { reason_code: opts.reasonCode ?? "store_busy" } : {}),
      ...(newStatus === "Acknowledged" && opts.prepTimeMins ? { extra: { prep_time_mins: opts.prepTimeMins } } : {}),
    });
    return { ok: true, message: r.message as string };
  }
}
