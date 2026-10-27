import type { CfdLine, CfdState } from "@stello/shared";

/**
 * In-page store the POS writes its running cart / payment QR into; the paired
 * customer display link (components/foh/CfdLink) subscribes and pushes it to
 * the API. Billing and the settle dialog only call the two publish helpers, so
 * they stay unaware of pairing and transport.
 */
type CartSnapshot = {
  label: string | null;
  lines: CfdLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};

const EMPTY: CartSnapshot = { label: null, lines: [], subtotal: 0, discount: 0, tax: 0, total: 0 };
let cart: CartSnapshot = EMPTY;
let upi: CfdState["upi"] = null;
const listeners = new Set<() => void>();

export function publishCfdCart(next: CartSnapshot | null) {
  cart = next ?? EMPTY;
  if (!next) upi = null;
  listeners.forEach((l) => l());
}

export function publishCfdPayment(next: { upiString: string; amount: number; payeeVpa: string } | null) {
  upi = next;
  listeners.forEach((l) => l());
}

export function currentCfdState(): CfdState {
  const mode = upi ? "PAYMENT" : cart.lines.length ? "CART" : "IDLE";
  return { mode, ...cart, upi };
}

export function subscribeCfd(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const cfdSessionKey = (outletId: string) => `stello.cfd.${outletId}`;
