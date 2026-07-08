import { BadRequestException } from "@nestjs/common";
import { verifyHmacSha256, type WebhookHeaders } from "./signatures";
import type { CanonicalOrder, PlatformAdapter } from "./types";

/**
 * Zomato Order Relay webhook → canonical order. Shapes follow Zomato's public
 * POS-integration docs (order_id, store, order_items[], customer). In production
 * the store id maps to our outlet via an onboarding-time mapping table; here the
 * payload carries our outletId directly.
 */
export class ZomatoAdapter implements PlatformAdapter {
  readonly platform = "ZOMATO" as const;

  // Zomato Order Relay signs the raw body with HMAC-SHA256 and sends the hex
  // digest in X-Zomato-Signature; the secret is issued at POS onboarding.
  verifySignature(rawBody: Buffer, headers: WebhookHeaders): void {
    verifyHmacSha256({ platform: this.platform, rawBody, headers, headerName: "X-Zomato-Signature", secretEnv: "ZOMATO_WEBHOOK_SECRET" });
  }

  parseOrder(payload: unknown): CanonicalOrder {
    const p = payload as {
      order_id?: string;
      store?: { pos_outlet_id?: string };
      order_items?: { item_id?: string; quantity?: number }[];
      customer?: { name?: string; masked_phone?: string };
      order_total?: number;
    };
    if (!p?.order_id || !p?.store?.pos_outlet_id || !Array.isArray(p.order_items)) {
      throw new BadRequestException("Malformed Zomato order payload");
    }
    return {
      platform: "ZOMATO",
      externalOrderId: p.order_id,
      outletId: p.store.pos_outlet_id,
      items: p.order_items
        .filter((i) => i.item_id && i.quantity)
        .map((i) => ({ externalItemId: i.item_id!, quantity: Number(i.quantity) })),
      customerName: p.customer?.name ?? null,
      customerPhoneMasked: p.customer?.masked_phone ?? null,
      orderValue: Number(p.order_total ?? 0),
      rawPayload: payload,
    };
  }
}
