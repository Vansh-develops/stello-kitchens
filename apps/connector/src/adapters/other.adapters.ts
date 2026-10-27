import { BadRequestException } from "@nestjs/common";
import { verifyHmacSha256, verifyOndcEd25519, verifyStaticToken, type WebhookHeaders } from "./signatures";
import type { CanonicalOrder, PlatformAdapter } from "./types";

/**
 * Swiggy direct adapter — PARTNER-GATED. Swiggy's restaurant order/menu API is
 * only available to onboarded POS partners and has no public schema, so the
 * field names below (orderId/outletId/items[].externalItemId/qty/total) and the
 * X-Swiggy-Signature HMAC are NOT confirmed against Swiggy documentation and
 * must be replaced with the partner spec at onboarding. Production Swiggy
 * orders should arrive through UrbanPiper (see UrbanPiperAdapter), which is
 * fully documented and needs no Swiggy partnership.
 */
export class SwiggyAdapter implements PlatformAdapter {
  readonly platform = "SWIGGY" as const;

  verifySignature(rawBody: Buffer, headers: WebhookHeaders): void {
    verifyHmacSha256({ platform: this.platform, rawBody, headers, headerName: "X-Swiggy-Signature", secretEnv: "SWIGGY_WEBHOOK_SECRET" });
  }

  parseOrder(payload: unknown): CanonicalOrder {
    const p = payload as {
      orderId?: string;
      outletId?: string;
      items?: { externalItemId?: string; qty?: number }[];
      customer?: { name?: string; phone?: string };
      total?: number;
    };
    if (!p?.orderId || !p?.outletId || !Array.isArray(p.items)) {
      throw new BadRequestException("Malformed Swiggy order payload");
    }
    return {
      platform: "SWIGGY",
      externalOrderId: p.orderId,
      outletId: p.outletId,
      items: p.items.filter((i) => i.externalItemId && i.qty).map((i) => ({ externalItemId: i.externalItemId!, quantity: Number(i.qty) })),
      customerName: p.customer?.name ?? null,
      customerPhoneMasked: p.customer?.phone ?? null,
      orderValue: Number(p.total ?? 0),
      rawPayload: payload,
    };
  }
}

/**
 * ONDC/Beckn `/confirm` (seller side, ONDC:RET11). Per the public protocol the
 * order carries `provider.id` (our outlet as registered in the catalogue),
 * `items[].id` + `quantity.count`, `billing` and `quote.price.value`; the order id
 * is BAP-assigned (`order.id`), falling back to the transaction id.
 */
export class OndcAdapter implements PlatformAdapter {
  readonly platform = "ONDC" as const;

  verifySignature(rawBody: Buffer, headers: WebhookHeaders): void {
    verifyOndcEd25519({ rawBody, headers });
  }

  parseOrder(payload: unknown): CanonicalOrder {
    const p = payload as {
      context?: { transaction_id?: string; action?: string };
      message?: {
        order?: {
          id?: string;
          provider?: { id?: string };
          items?: { id?: string; quantity?: { count?: number | string } }[];
          quote?: { price?: { value?: string } };
          billing?: { name?: string; phone?: string };
        };
      };
    };
    const order = p?.message?.order;
    if (!p?.context?.transaction_id || !order?.provider?.id || !Array.isArray(order.items)) {
      throw new BadRequestException("Malformed ONDC /confirm payload");
    }
    return {
      platform: "ONDC",
      externalOrderId: order.id ?? p.context.transaction_id,
      outletId: order.provider.id,
      items: order.items
        .filter((i) => i.id && Number(i.quantity?.count) > 0)
        .map((i) => ({ externalItemId: i.id!, quantity: Number(i.quantity!.count) })),
      customerName: order.billing?.name ?? null,
      customerPhoneMasked: order.billing?.phone ? `******${order.billing.phone.slice(-4)}` : null,
      orderValue: Number(order.quote?.price?.value ?? 0),
      rawPayload: payload,
    };
  }
}

/**
 * UrbanPiper Order Relay webhook (api-docs.urbanpiper.com → Order Relay). One
 * canonical shape for every aggregator UrbanPiper fans out to:
 *   order.details.id · order.details.order_total · order.store.merchant_ref_id
 *   order.items[].merchant_id / quantity · customer.name / phone
 * The store's merchant_ref_id is our outlet id (set when the store is created in
 * Atlas) and items' merchant_id is the ref_id we pushed with the menu.
 *
 * UrbanPiper does not sign webhooks; it sends the static headers configured on
 * the webhook. We register a secret `X-Stello-Webhook-Token` there and compare it
 * in constant time.
 */
export class UrbanPiperAdapter implements PlatformAdapter {
  readonly platform = "URBANPIPER" as const;

  verifySignature(_rawBody: Buffer, headers: WebhookHeaders): void {
    verifyStaticToken({ platform: this.platform, headers, headerName: "X-Stello-Webhook-Token", secretEnv: "URBANPIPER_WEBHOOK_SECRET" });
  }

  parseOrder(payload: unknown): CanonicalOrder {
    const p = payload as {
      customer?: { name?: string; phone?: string };
      order?: {
        details?: { id?: number | string; order_total?: number };
        store?: { merchant_ref_id?: string };
        items?: { merchant_id?: string; quantity?: number }[];
      };
    };
    const o = p?.order;
    if (o?.details?.id == null || !o.store?.merchant_ref_id || !Array.isArray(o.items)) {
      throw new BadRequestException("Malformed UrbanPiper order payload");
    }
    const phone = p.customer?.phone;
    return {
      platform: "URBANPIPER",
      externalOrderId: String(o.details.id), // UrbanPiper order id — used for status updates
      outletId: o.store.merchant_ref_id,
      items: o.items.filter((i) => i.merchant_id && i.quantity).map((i) => ({ externalItemId: i.merchant_id!, quantity: Number(i.quantity) })),
      customerName: p.customer?.name ?? null,
      customerPhoneMasked: phone ? `******${phone.slice(-4)}` : null,
      orderValue: Number(o.details.order_total ?? 0),
      rawPayload: payload,
    };
  }
}
