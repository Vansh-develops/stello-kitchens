import type { AggregatorPlatform } from "@petpooja/shared";

/** The normalised order shape the connector forwards to the main API. */
export interface CanonicalOrder {
  platform: AggregatorPlatform;
  externalOrderId: string;
  outletId: string;
  items: { externalItemId: string; quantity: number }[];
  customerName?: string | null;
  customerPhoneMasked?: string | null;
  orderValue: number;
  rawPayload: unknown;
}

/**
 * A platform adapter translates a provider-specific webhook payload into the
 * canonical order. Each aggregator has its own field names and auth; this is the
 * seam that keeps the rest of the connector provider-agnostic.
 */
export interface PlatformAdapter {
  readonly platform: AggregatorPlatform;
  parseOrder(payload: unknown): CanonicalOrder;
}
