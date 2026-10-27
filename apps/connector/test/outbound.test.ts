import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { UrbanPiperClient, toUrbanPiperStatus, urbanPiperMenuPayload } from "../src/outbound/urbanpiper.client";
import { PushService } from "../src/outbound/push.service";
import { ondcCatalog, ondcOnStatus, signOndcRequest, verifyOndcAuthorization } from "../src/outbound/ondc";
import { OndcAdapter, UrbanPiperAdapter } from "../src/adapters/other.adapters";

const UP = "https://pos-int.urbanpiper.com";
const cfg = { baseUrl: UP, username: "biz_user", apiKey: "k3y", bizId: "77001", platforms: ["zomato", "swiggy"] };
const catalog = [
  { externalId: "I-1", title: "Paneer Tikka", description: null, price: 249, inStock: true, isVeg: true, categoryRef: "C-1", categoryName: "Starters", outletName: "HSR" },
  { externalId: "I-2", title: "Chicken 65", description: null, price: 279.5, inStock: false, isVeg: false, categoryRef: "C-1", categoryName: "Starters", outletName: "HSR" },
];

type Seen = { path: string; method: string; headers: Record<string, string>; body: any };
const headerMap = (h: unknown) => {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
};
const record = (seen: Seen[], reply: unknown, statusCode = 200) => (o: { path: string; method: string; headers?: unknown; body?: unknown }) => {
  seen.push({ path: o.path, method: o.method, headers: headerMap(o.headers), body: o.body ? JSON.parse(String(o.body)) : null });
  return { statusCode, data: JSON.stringify(reply), responseOptions: { headers: { "content-type": "application/json" } } };
};

let agent: MockAgent;
let previous: Dispatcher;
beforeEach(() => {
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  setGlobalDispatcher(previous);
  await agent.close();
});

describe("UrbanPiper outbound client", () => {
  it("pushes the catalogue with apikey auth + biz id, categories and veg food types", async () => {
    const seen: Seen[] = [];
    agent.get(UP).intercept({ path: "/external/api/v1/inventory/locations/outlet-1/", method: "POST" })
      .reply(record(seen, { status: "success", message: "Catalogue queued", reference: "ref-menu" }));
    const res = await new UrbanPiperClient(cfg).pushMenu("outlet-1", catalog);
    expect(res).toMatchObject({ ok: true, referenceId: "ref-menu" });
    expect(seen[0].headers.authorization).toBe("apikey biz_user:k3y");
    expect(seen[0].headers["x-upr-biz-id"]).toBe("77001");
    expect(seen[0].body).toMatchObject({
      flush_items: false,
      categories: [{ ref_id: "C-1", name: "Starters", active: true }],
      items: [
        { ref_id: "I-1", title: "Paneer Tikka", available: true, price: 249, food_type: "1", category_ref_ids: ["C-1"], current_stock: -1 },
        { ref_id: "I-2", available: false, price: 279.5, food_type: "2" },
      ],
    });
  });

  it("toggles item availability and stores per platform", async () => {
    const seen: Seen[] = [];
    const pool = agent.get(UP);
    pool.intercept({ path: "/hub/api/v1/items/", method: "POST" }).reply(record(seen, { status: "success", reference_id: "r1" })).times(2);
    pool.intercept({ path: "/hub/api/v1/location/", method: "POST" }).reply(record(seen, { status: "success", reference_id: "r2" }));
    const push = new PushService({ catalog: async () => catalog } as any, new UrbanPiperClient(cfg));
    const stock = await push.stock("URBANPIPER", "outlet-1");
    expect(stock.detail).toEqual({ enabled: ["I-1"], disabled: ["I-2"] });
    const bodies = seen.map((s) => s.body);
    expect(bodies).toContainEqual({ location_ref_id: "outlet-1", item_ref_ids: ["I-2"], action: "disable" });
    expect(bodies).toContainEqual({ location_ref_id: "outlet-1", item_ref_ids: ["I-1"], action: "enable" });
    await push.store("URBANPIPER", "outlet-1", false, "Kitchen closed early");
    expect(seen[2].body).toEqual({ location_ref_id: "outlet-1", platforms: ["zomato", "swiggy"], action: "disable", reason: "Kitchen closed early" });
  });

  it("sends order status callbacks, treating 'already in status' as success", async () => {
    const seen: Seen[] = [];
    const pool = agent.get(UP);
    pool.intercept({ path: "/external/api/v1/orders/3444567/status/", method: "PUT" }).reply(record(seen, { status: "success", message: "updated" }));
    pool.intercept({ path: "/external/api/v1/orders/3444567/status/", method: "PUT" })
      .reply(400, { status: "error", err_code: "err_order_already_in_status", message: "already" });
    const client = new UrbanPiperClient(cfg);
    await client.updateOrderStatus("3444567", "ACCEPTED", { prepTimeMins: 20 });
    expect(seen[0].body).toMatchObject({ new_status: "Acknowledged", extra: { prep_time_mins: 20 } });
    await expect(client.updateOrderStatus("3444567", "ACCEPTED")).resolves.toMatchObject({ ok: true });
    expect(toUrbanPiperStatus("READY")).toBe("Food Ready");
    expect(toUrbanPiperStatus("PICKED_UP")).toBe("Dispatched");
    expect(toUrbanPiperStatus("PREPARING")).toBeNull();
  });

  it("simulates (no network) without credentials and refuses direct partner-gated platforms", async () => {
    const push = new PushService({ catalog: async () => catalog } as any, new UrbanPiperClient(null));
    await expect(push.store("URBANPIPER", "o", true)).resolves.toMatchObject({ simulated: true });
    await expect(push.menu("SWIGGY", "o")).rejects.toThrow("partner onboarding");
    expect(urbanPiperMenuPayload(catalog).categories).toHaveLength(1);
  });
});

describe("inbound adapters", () => {
  it("parses the documented UrbanPiper order relay and checks the static webhook token", () => {
    const a = new UrbanPiperAdapter();
    const body = {
      customer: { name: "Asha", phone: "9876543210" },
      order: { details: { id: 3444567, order_total: 625.25 }, store: { merchant_ref_id: "outlet-1" }, items: [{ merchant_id: "I-1", quantity: 2 }] },
    };
    expect(a.parseOrder(body)).toMatchObject({
      externalOrderId: "3444567", outletId: "outlet-1", orderValue: 625.25, customerPhoneMasked: "******3210",
      items: [{ externalItemId: "I-1", quantity: 2 }],
    });
    expect(() => a.verifySignature(Buffer.from("{}"), { "x-stello-webhook-token": "dev-urbanpiper-secret" })).not.toThrow();
    expect(() => a.verifySignature(Buffer.from("{}"), { "x-stello-webhook-token": "nope" })).toThrow("Invalid");
    expect(() => a.verifySignature(Buffer.from("{}"), {})).toThrow("Missing");
  });

  it("verifies ONDC signatures over the Beckn signing string and rejects tampering and expiry", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const body = JSON.stringify({ context: { transaction_id: "t1" } });
    const now = 1_800_000_000;
    const auth = signOndcRequest(body, { subscriberId: "bap.example.com", uniqueKeyId: "k1", privateKeyB64: seed }, now);
    expect(auth).toMatch(/^Signature keyId="bap.example.com\|k1\|ed25519",algorithm="ed25519",created="1800000000",expires="1800000300"/);
    expect(verifyOndcAuthorization(Buffer.from(body), auth, pub, now + 10)).toBe(true);
    expect(verifyOndcAuthorization(Buffer.from(body + " "), auth, pub, now + 10)).toBe(false);
    expect(verifyOndcAuthorization(Buffer.from(body), auth, pub, now + 1000)).toBe(false);
  });

  it("maps ONDC /confirm, catalogue and on_status payloads", () => {
    const parsed = new OndcAdapter().parseOrder({
      context: { transaction_id: "txn-1" },
      message: { order: { id: "O-9", provider: { id: "outlet-1" }, items: [{ id: "I-1", quantity: { count: "2" } }], quote: { price: { value: "498.00" } } } },
    });
    expect(parsed).toMatchObject({ externalOrderId: "O-9", items: [{ externalItemId: "I-1", quantity: 2 }], orderValue: 498 });
    const cat = ondcCatalog({ id: "outlet-1", name: "HSR", locationId: "outlet-1-L1" }, catalog);
    const item = cat.catalog["bpp/providers"][0].items[1];
    expect(item).toMatchObject({ id: "I-2", price: { currency: "INR", value: "279.50" }, quantity: { available: { count: "0" } } });
    expect(item.tags[0].list[0]).toEqual({ code: "non_veg", value: "yes" });
    expect(ondcOnStatus("O-9", "READY")?.order).toMatchObject({ state: "In-progress", fulfillments: [{ state: { descriptor: { code: "Packed" } } }] });
  });
});
