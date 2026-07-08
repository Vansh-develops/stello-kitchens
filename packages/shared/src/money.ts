// Money is computed in integer paise, never in floating-point rupees. Summing
// rupee floats (e.g. 10.10 + 20.20 + ...) accumulates representation error that a
// trailing round() only sometimes hides; doing the arithmetic in whole paise makes
// every subtotal/discount/total exact. This module is the single source of the
// formula so the cloud API and the offline edge device produce identical figures.

/** Rupees (possibly fractional) → integer paise, rounded to the nearest paisa. */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Integer paise → rupees with exactly two decimals. */
export function fromPaise(paise: number): number {
  return Math.round(paise) / 100;
}

/** Unit price (rupees) × quantity → an exact integer-paise line total. */
export function lineTotalPaise(unitPriceRupees: number, quantity: number): number {
  return toPaise(unitPriceRupees) * quantity;
}

/** A line as the money math sees it: its total value in paise and tax rate (percent). */
export interface MoneyLine {
  lineTotalPaise: number;
  taxRatePercent: number;
}

export interface OrderTotals {
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
}

/**
 * Compute order totals entirely in integer paise. The discount is applied before
 * tax and spread proportionally across the taxed base; only the tax carries a
 * single rounding to the nearest paisa. Returns rupee amounts (two decimals).
 *
 * This is algebraically identical to the previous rupee formula for clean inputs,
 * but eliminates float drift when many lines are summed, so the server and edge
 * agree to the paisa on every order.
 */
export function computeOrderTotals(lines: MoneyLine[], discountRupees: number): OrderTotals {
  const subtotalPaise = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  const discountPaise = Math.min(Math.max(0, toPaise(discountRupees)), subtotalPaise);
  const taxablePaise = subtotalPaise - discountPaise;
  // rawTaxPaise is rate% of each line's paise (may be fractional); scale by
  // taxable/subtotal to carry the discount, then round exactly once.
  const rawTaxPaise = lines.reduce((s, l) => s + (l.lineTotalPaise * l.taxRatePercent) / 100, 0);
  const taxPaise = subtotalPaise > 0 ? Math.round((rawTaxPaise * taxablePaise) / subtotalPaise) : 0;
  const totalPaise = taxablePaise + taxPaise;
  return {
    subtotal: fromPaise(subtotalPaise),
    discountAmount: fromPaise(discountPaise),
    taxAmount: fromPaise(taxPaise),
    total: fromPaise(totalPaise),
  };
}
