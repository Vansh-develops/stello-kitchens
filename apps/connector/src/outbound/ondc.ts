import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

/**
 * ONDC (Beckn) seller-side helpers for the F&B domain (ONDC:RET11, core 1.2.x),
 * following the public ONDC protocol specs (github.com/ONDC-Official):
 *  - request signing / verification (ed25519 over the Beckn signing string)
 *  - /on_search catalogue and /on_status payload mappers
 * Live network participation additionally needs ONDC registry onboarding
 * (subscriber id, unique key id, registered key pair) — see the env vars.
 */

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function blake512Digest(body: Buffer | string): string {
  return createHash("blake2b512").update(body).digest("base64");
}

/** Beckn signing string: "(created): …\n(expires): …\ndigest: BLAKE-512=<base64>". */
export function ondcSigningString(created: number, expires: number, body: Buffer | string): string {
  return `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${blake512Digest(body)}`;
}

/** Private key as base64: a 32-byte seed or a 64-byte libsodium secret key (seed ‖ public). */
function privateKeyFrom(b64: string) {
  const raw = Buffer.from(b64, "base64");
  const seed = raw.length === 64 ? raw.subarray(0, 32) : raw;
  if (seed.length !== 32) throw new Error("ONDC signing key must be a base64 ed25519 seed or secret key");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

function publicKeyFrom(b64: string) {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(b64, "base64")]), format: "der", type: "spki" });
}

/** Build the `Authorization` header for an outbound ONDC call. */
export function signOndcRequest(
  body: string,
  key: { subscriberId: string; uniqueKeyId: string; privateKeyB64: string },
  nowSec = Math.floor(Date.now() / 1000),
  ttlSec = 300,
): string {
  const created = nowSec;
  const expires = nowSec + ttlSec;
  const signature = edSign(null, Buffer.from(ondcSigningString(created, expires, body)), privateKeyFrom(key.privateKeyB64)).toString("base64");
  return (
    `Signature keyId="${key.subscriberId}|${key.uniqueKeyId}|ed25519",algorithm="ed25519",` +
    `created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${signature}"`
  );
}

export interface ParsedOndcAuth {
  subscriberId: string;
  uniqueKeyId: string;
  created: number;
  expires: number;
  signature: string;
}

export function parseOndcAuthorization(header: string): ParsedOndcAuth | null {
  const field = (name: string) => header.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  const keyId = field("keyId");
  const created = Number(field("created"));
  const expires = Number(field("expires"));
  const signature = field("signature");
  if (!keyId || !signature || !Number.isFinite(created) || !Number.isFinite(expires)) return null;
  const [subscriberId, uniqueKeyId] = keyId.split("|");
  if (!subscriberId || !uniqueKeyId) return null;
  return { subscriberId, uniqueKeyId, created, expires, signature };
}

/** Verify a Beckn Authorization header against the caller's registry public key. */
export function verifyOndcAuthorization(rawBody: Buffer, header: string, publicKeyB64: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const p = parseOndcAuthorization(header);
  if (!p) return false;
  if (p.created > nowSec + 60 || p.expires < nowSec) return false; // stale or from the future
  try {
    return edVerify(null, Buffer.from(ondcSigningString(p.created, p.expires, rawBody)), publicKeyFrom(publicKeyB64), Buffer.from(p.signature, "base64"));
  } catch {
    return false;
  }
}

// ---------- Payload mappers ----------

export interface OndcContextIn {
  transaction_id: string;
  message_id?: string;
  bap_id?: string;
  bap_uri?: string;
  city?: string;
}

export function ondcContext(action: string, incoming: OndcContextIn, bpp: { id: string; uri: string }, now = new Date()) {
  return {
    domain: "ONDC:RET11",
    country: "IND",
    city: incoming.city ?? "std:080",
    action,
    core_version: "1.2.0",
    bap_id: incoming.bap_id,
    bap_uri: incoming.bap_uri,
    bpp_id: bpp.id,
    bpp_uri: bpp.uri,
    transaction_id: incoming.transaction_id,
    message_id: incoming.message_id,
    timestamp: now.toISOString(),
    ttl: "PT30S",
  };
}

export interface OndcCatalogItem {
  externalId: string;
  title: string;
  price: number;
  inStock: boolean;
  isVeg: boolean;
  categoryName: string;
}

/** `/on_search` catalogue for one provider (outlet) and location. */
export function ondcCatalog(provider: { id: string; name: string; locationId: string; gps?: string }, items: OndcCatalogItem[]) {
  return {
    catalog: {
      "bpp/descriptor": { name: provider.name },
      "bpp/providers": [
        {
          id: provider.id,
          descriptor: { name: provider.name },
          locations: [{ id: provider.locationId, ...(provider.gps ? { gps: provider.gps } : {}) }],
          items: items.map((i) => ({
            id: i.externalId,
            descriptor: { name: i.title },
            price: { currency: "INR", value: i.price.toFixed(2), maximum_value: i.price.toFixed(2) },
            category_id: i.categoryName,
            location_id: provider.locationId,
            quantity: { available: { count: i.inStock ? "99" : "0" }, maximum: { count: i.inStock ? "99" : "0" } },
            "@ondc/org/returnable": false,
            "@ondc/org/cancellable": false,
            "@ondc/org/available_on_cod": false,
            "@ondc/org/time_to_ship": "PT45M",
            "@ondc/org/seller_pickup_return": false,
            "@ondc/org/contact_details_consumer_care": "",
            tags: [{ code: "veg_nonveg", list: [{ code: i.isVeg ? "veg" : "non_veg", value: "yes" }] }],
          })),
        },
      ],
    },
  };
}

/** Our aggregator status → ONDC order.state + fulfillment state (RET11). */
export function toOndcState(status: string): { order: string; fulfillment: string } | null {
  switch (status) {
    case "ACCEPTED":
      return { order: "Accepted", fulfillment: "Pending" };
    case "PREPARING":
      return { order: "In-progress", fulfillment: "Pending" };
    case "READY":
      return { order: "In-progress", fulfillment: "Packed" };
    case "PICKED_UP":
      return { order: "In-progress", fulfillment: "Order-picked-up" };
    case "DELIVERED":
      return { order: "Completed", fulfillment: "Order-delivered" };
    case "REJECTED":
    case "CANCELLED":
      return { order: "Cancelled", fulfillment: "Cancelled" };
    default:
      return null;
  }
}

/** `/on_status` message for an order the buyer app placed via /confirm. */
export function ondcOnStatus(orderId: string, status: string, fulfillmentId = "F1", now = new Date()) {
  const st = toOndcState(status);
  if (!st) return null;
  return {
    order: {
      id: orderId,
      state: st.order,
      fulfillments: [{ id: fulfillmentId, state: { descriptor: { code: st.fulfillment } } }],
      updated_at: now.toISOString(),
    },
  };
}
