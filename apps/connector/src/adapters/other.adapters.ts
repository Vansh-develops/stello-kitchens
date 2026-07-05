import { BadRequestException } from "@nestjs/common";
import { verifyHmacSha256, verifyOndcEd25519, type WebhookHeaders } from "./signatures";
import type { CanonicalOrder, PlatformAdapter } from "./types";

/**
 * Swiggy adapter (stub). Swiggy's 3rd-party Order Management API is partner-gated
 * (API key + secret, token auth) with no public schema; this parses a plausible
 * shape so the interface is exercised end-to-end. Auth/menu-sync land at onboarding.
 */
export class SwiggyAdapter implements PlatformAdapter {
  readonly platform = "SWIGGY" as const;

  // Swiggy's partner Order API signs the raw body with HMAC-SHA256 using the
  // partner secret, delivered in X-Swiggy-Signature.
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
 * ONDC/Beckn adapter (stub). Seller-side flow implements /confirm with ed25519
 * signature verification (RET11 domain). This parses the item list from a Beckn
 * `/confirm` order; signing/registry lookups are onboarding concerns.
 */
export class OndcAdapter implements PlatformAdapter {
  readonly platform = "ONDC" as const;

  // ONDC/Beckn signs a blake2b-512 hash of the body with ed25519 (Authorization
  // signature block). Live registry key resolution is GATED to onboarding; see
  // verifyOndcEd25519.
  verifySignature(rawBody: Buffer, headers: WebhookHeaders): void {
    verifyOndcEd25519({ rawBody, headers });
  }

  parseOrder(payload: unknown): CanonicalOrder {
    const p = payload as {
      context?: { transaction_id?: string; bpp_id?: string };
      message?: {
        order?: {
          provider?: { id?: string };
          items?: { id?: string; quantity?: { count?: number } }[];
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
      externalOrderId: p.context.transaction_id,
      outletId: order.provider.id,
      items: order.items
        .filter((i) => i.id && i.quantity?.count)
        .map((i) => ({ externalItemId: i.id!, quantity: Number(i.quantity!.count) })),
      customerName: order.billing?.name ?? null,
      customerPhoneMasked: order.billing?.phone ?? null,
      orderValue: Number(order.quote?.price?.value ?? 0),
      rawPayload: payload,
    };
  }
}

/**
 * UrbanPiper/Dyno middleware adapter — the fastest path pre-certification. The
 * middleware fans out to every aggregator and delivers a single canonical shape,
 * so this parser is the simplest of all.
 */
export class UrbanPiperAdapter implements PlatformAdapter {
  readonly platform = "URBANPIPER" as const;

  // UrbanPiper/Dyno signs webhook bodies with HMAC-SHA256 (per-integration secret)
  // and sends the hex digest in X-UrbanPiper-Signature.
  verifySignature(rawBody: Buffer, headers: WebhookHeaders): void {
    verifyHmacSha256({ platform: this.platform, rawBody, headers, headerName: "X-UrbanPiper-Signature", secretEnv: "URBANPIPER_WEBHOOK_SECRET" });
  }

  parseOrder(payload: unknown): CanonicalOrder {
    const p = payload as {
      order_ref?: string;
      location_ref?: string;
      items?: { ref_id?: string; quantity?: number }[];
      customer?: { name?: string; phone?: string };
      amount?: number;
    };
    if (!p?.order_ref || !p?.location_ref || !Array.isArray(p.items)) {
      throw new BadRequestException("Malformed UrbanPiper order payload");
    }
    return {
      platform: "URBANPIPER",
      externalOrderId: p.order_ref,
      outletId: p.location_ref,
      items: p.items.filter((i) => i.ref_id && i.quantity).map((i) => ({ externalItemId: i.ref_id!, quantity: Number(i.quantity) })),
      customerName: p.customer?.name ?? null,
      customerPhoneMasked: p.customer?.phone ?? null,
      orderValue: Number(p.amount ?? 0),
      rawPayload: payload,
    };
  }
}
