export interface CouponRule {
  type: "PERCENT" | "FLAT";
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  validFrom: string | null;
  validTo: string | null;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

export interface CouponEvaluation {
  valid: boolean;
  discount: number;
  message: string;
}

/**
 * Pure coupon evaluation shared by the settle path and the dashboard preview, so
 * both agree on the rules. `nowIso` is passed in (no ambient clock).
 */
export function evaluateCoupon(
  coupon: CouponRule | null,
  subtotal: number,
  nowIso: string,
): CouponEvaluation {
  if (!coupon) return { valid: false, discount: 0, message: "Coupon not found" };
  if (!coupon.isActive) return { valid: false, discount: 0, message: "Coupon is inactive" };

  const now = new Date(nowIso).getTime();
  if (coupon.validFrom && now < new Date(coupon.validFrom).getTime()) {
    return { valid: false, discount: 0, message: "Coupon is not valid yet" };
  }
  if (coupon.validTo && now > new Date(coupon.validTo).getTime()) {
    return { valid: false, discount: 0, message: "Coupon has expired" };
  }
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, discount: 0, message: "Coupon usage limit reached" };
  }
  if (subtotal < coupon.minOrder) {
    return { valid: false, discount: 0, message: `Requires a minimum order of ₹${coupon.minOrder}` };
  }

  let discount = coupon.type === "PERCENT" ? (subtotal * coupon.value) / 100 : coupon.value;
  if (coupon.maxDiscount != null) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.min(discount, subtotal);
  discount = Math.round(discount * 100) / 100;
  return { valid: true, discount, message: "Coupon applied" };
}
