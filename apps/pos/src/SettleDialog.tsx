import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { CustomerLookupDto, OrderDto, PaymentMode } from "@petpooja/shared";
import { api, ApiError } from "./api";

const rupee = (n: number) => `₹${n.toFixed(2)}`;
const MODES: PaymentMode[] = ["CASH", "CARD", "UPI", "WALLET"];

export function SettleDialog({
  order,
  outletId,
  onClose,
  onSettled,
}: {
  order: OrderDto;
  outletId: string;
  onClose: () => void;
  onSettled: (order: OrderDto) => void;
}) {
  const [discount, setDiscount] = useState(0);
  const [split, setSplit] = useState<Record<PaymentMode, number>>({
    CASH: 0,
    CARD: 0,
    UPI: 0,
    WALLET: 0,
    OTHER: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Customer / offers
  const [phone, setPhone] = useState(order.customerPhone ?? "");
  const [customer, setCustomer] = useState<CustomerLookupDto | null>(null);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [couponCode, setCouponCode] = useState("");
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);

  // Redemption OTP
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpMsg, setOtpMsg] = useState<string | null>(null);

  // Look up loyalty when a full phone is entered.
  useEffect(() => {
    const p = phone.trim();
    if (p.length < 10) {
      setCustomer(null);
      setRedeemPoints(0);
      return;
    }
    let cancelled = false;
    void api
      .lookupCustomer(outletId, p)
      .then((c) => !cancelled && setCustomer(c))
      .catch(() => !cancelled && setCustomer(null));
    return () => {
      cancelled = true;
    };
  }, [phone, outletId]);

  const redeemDiscount = customer ? redeemPoints * customer.pointValue : 0;
  const totalDiscount = Math.min(discount + couponDiscount + redeemDiscount, order.subtotal);

  const payable = useMemo(() => {
    const taxable = order.subtotal - totalDiscount;
    const tax = order.subtotal > 0 ? order.taxAmount * (taxable / order.subtotal) : 0;
    return Math.round((taxable + tax) * 100) / 100;
  }, [totalDiscount, order]);

  const paid = useMemo(() => Object.values(split).reduce((s, n) => s + n, 0), [split]);
  const remaining = Math.round((payable - paid) * 100) / 100;

  const setMode = (mode: PaymentMode, amount: number) =>
    setSplit((prev) => ({ ...prev, [mode]: Math.max(0, amount) }));
  const payFull = (mode: PaymentMode) =>
    setSplit({ CASH: 0, CARD: 0, UPI: 0, WALLET: 0, OTHER: 0, [mode]: payable });

  const applyCoupon = async () => {
    const code = couponCode.trim();
    if (!code) return;
    setCouponMsg(null);
    try {
      const res = await api.previewCoupon(outletId, code, order.subtotal);
      setCouponDiscount(res.valid ? res.discount : 0);
      setCouponMsg(res.message);
    } catch {
      setCouponDiscount(0);
      setCouponMsg("Could not check coupon");
    }
  };

  const maxRedeemable = customer
    ? Math.min(customer.loyaltyPoints, Math.floor((order.subtotal - discount - couponDiscount) / customer.pointValue))
    : 0;

  // Dynamic UPI QR for the current payable amount.
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrVpa, setQrVpa] = useState<string | null>(null);
  const showUpiQr = async () => {
    if (qrDataUrl) {
      setQrDataUrl(null);
      return;
    }
    try {
      const qr = await api.upiQr(outletId, order.id, payable);
      const png = await QRCode.toDataURL(qr.upiString, { margin: 1, width: 180, color: { dark: "#14110f", light: "#f4ede2" } });
      setQrDataUrl(png);
      setQrVpa(qr.payeeVpa);
    } catch {
      setError("Could not generate UPI QR");
    }
  };

  const sendOtp = async () => {
    setOtpMsg(null);
    try {
      const res = await api.requestLoyaltyOtp(outletId, phone.trim());
      setOtpSent(true);
      setOtpMsg(`OTP sent to ${phone.trim()} — read it to the customer to confirm.`);
      void res;
    } catch (err) {
      setOtpMsg(err instanceof ApiError ? err.message : "Could not send OTP");
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payments = MODES.filter((m) => split[m] > 0).map((m) => ({ mode: m, amount: split[m] }));
      if (payments.length === 0) {
        setError("Add at least one payment.");
        setBusy(false);
        return;
      }
      if (redeemPoints > 0 && !otp.trim()) {
        setError("Enter the redemption OTP to redeem points.");
        setBusy(false);
        return;
      }
      const settled = await api.settle(order.id, {
        payments,
        discountAmount: discount > 0 ? discount : undefined,
        couponCode: couponDiscount > 0 ? couponCode.trim() : undefined,
        redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
        redeemOtp: redeemPoints > 0 ? otp.trim() : undefined,
        customerPhone: phone.trim() || undefined,
      });
      onSettled(settled);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not settle");
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal settle-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Settle bill</h2>
            <span className="settle-sub">
              {order.tableName ?? order.orderType.replace("_", " ")} · {order.items.length} items
            </span>
          </div>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="cust-offers">
            <div className="co-phone">
              <input
                placeholder="Customer phone (for loyalty)"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="numeric"
              />
              {customer?.found && (
                <span className="co-balance">
                  {customer.name ?? "Member"} · {customer.loyaltyPoints} pts
                </span>
              )}
            </div>

            {customer?.found && customer.loyaltyPoints > 0 && (
              <div className="co-redeem">
                <span>Redeem points</span>
                <div className="co-redeem-ctl">
                  <input
                    type="number"
                    min={0}
                    max={maxRedeemable}
                    value={redeemPoints || ""}
                    placeholder="0"
                    onChange={(e) => setRedeemPoints(Math.min(Number(e.target.value) || 0, maxRedeemable))}
                  />
                  <button className="co-max" onClick={() => setRedeemPoints(maxRedeemable)}>
                    Max {maxRedeemable}
                  </button>
                </div>
              </div>
            )}

            {redeemPoints > 0 && (
              <div className="co-otp">
                <button className="co-apply" onClick={sendOtp}>
                  {otpSent ? "Resend OTP" : "Send OTP"}
                </button>
                <input
                  placeholder="Redemption OTP"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  inputMode="numeric"
                  maxLength={6}
                />
              </div>
            )}
            {otpMsg && <p className="co-msg ok">{otpMsg}</p>}

            <div className="co-coupon">
              <input
                placeholder="Coupon code"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              />
              <button className="co-apply" onClick={applyCoupon}>
                Apply
              </button>
            </div>
            {couponMsg && (
              <p className={`co-msg ${couponDiscount > 0 ? "ok" : "bad"}`}>
                {couponMsg}
                {couponDiscount > 0 ? ` (−${rupee(couponDiscount)})` : ""}
              </p>
            )}
          </div>

          <div className="settle-summary">
            <div className="ss-row">
              <span>Subtotal</span>
              <span>{rupee(order.subtotal)}</span>
            </div>
            <div className="ss-row discount-row">
              <span>Manual discount</span>
              <input
                type="number"
                min={0}
                max={order.subtotal}
                value={discount || ""}
                placeholder="0"
                onChange={(e) => setDiscount(Number(e.target.value) || 0)}
              />
            </div>
            {couponDiscount > 0 && (
              <div className="ss-row">
                <span>Coupon {couponCode.trim()}</span>
                <span>−{rupee(couponDiscount)}</span>
              </div>
            )}
            {redeemDiscount > 0 && (
              <div className="ss-row">
                <span>Points redeemed ({redeemPoints})</span>
                <span>−{rupee(redeemDiscount)}</span>
              </div>
            )}
            <div className="ss-row">
              <span>Tax (CGST + SGST)</span>
              <span>{rupee(Math.round((payable - (order.subtotal - totalDiscount)) * 100) / 100)}</span>
            </div>
            <div className="ss-row grand">
              <span>Payable</span>
              <span>{rupee(payable)}</span>
            </div>
          </div>

          <div className="pay-modes">
            {MODES.map((m) => (
              <div key={m} className="pay-row">
                <button className="pay-full" onClick={() => payFull(m)}>
                  {m}
                </button>
                <input
                  type="number"
                  min={0}
                  value={split[m] || ""}
                  placeholder="0"
                  onChange={(e) => setMode(m, Number(e.target.value) || 0)}
                />
              </div>
            ))}
          </div>

          <div className="upi-qr-row">
            <button className="co-apply" onClick={showUpiQr} type="button">
              {qrDataUrl ? "Hide UPI QR" : "Show UPI QR"}
            </button>
            {qrDataUrl && (
              <div className="upi-qr">
                <img src={qrDataUrl} alt="UPI payment QR" width={140} height={140} />
                <span className="upi-qr-vpa">Scan to pay {rupee(payable)}<br />{qrVpa}</span>
              </div>
            )}
          </div>

          <div className={`remaining ${Math.abs(remaining) < 0.01 ? "settled" : ""}`}>
            {remaining > 0.01 ? (
              <span>Remaining {rupee(remaining)}</span>
            ) : remaining < -0.01 ? (
              <span>Change to return {rupee(-remaining)}</span>
            ) : (
              <span>Balanced ✓</span>
            )}
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button className="btn-primary grow" onClick={submit} disabled={busy || Math.abs(remaining) > 0.01}>
            {busy ? "Settling…" : `Settle & print · ${rupee(payable)}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
