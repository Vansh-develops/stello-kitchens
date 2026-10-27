"use client";

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { BillPreviewDto, CustomerLookupDto, GiftCardBalanceDto, OrderDto, PaymentMode } from "@stello/shared";
import { posApi as api } from "@/lib/pos-api";
import { hrApi } from "@/lib/hr-api";
import "../hr/hr.css";
import { publishCfdPayment } from "@/lib/cfd-mirror";
import { useT } from "@/lib/i18n";

const MODES: PaymentMode[] = ["CASH", "CARD", "UPI", "WALLET"];

export function SettleDialog({
  order: initialOrder,
  outletId,
  canRemoveServiceCharge = false,
  onClose,
  onSettled,
  onOrderChanged,
}: {
  order: OrderDto;
  outletId: string;
  canRemoveServiceCharge?: boolean;
  onClose: () => void;
  onSettled: (order: OrderDto) => void;
  onOrderChanged?: (order: OrderDto) => void;
}) {
  const [order, setOrder] = useState(initialOrder);
  const [discount, setDiscount] = useState(0);
  const [split, setSplit] = useState<Record<PaymentMode, number>>({
    CASH: 0,
    CARD: 0,
    UPI: 0,
    WALLET: 0,
    OTHER: 0,
    GIFT_CARD: 0,
  });
  // Gift card tender (balance is checked here and enforced under a lock at settle).
  const [gcCode, setGcCode] = useState("");
  const [gcInfo, setGcInfo] = useState<GiftCardBalanceDto | null>(null);
  const [gcMsg, setGcMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Leaving the settle dialog takes the QR off the customer display.
  useEffect(() => () => publishCfdPayment(null), []);
  const [busy, setBusy] = useState(false);
  const { t, money: rupee } = useT();

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

  // The server computes the exact bill (service charge, tax split, round-off) —
  // the same code path settlement uses — so "Payable" always matches.
  const [preview, setPreview] = useState<BillPreviewDto | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const appliedCoupon = couponDiscount > 0 ? couponCode.trim() : "";
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .preview(order.id, {
          discountAmount: discount > 0 ? discount : undefined,
          couponCode: appliedCoupon || undefined,
          redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
          customerPhone: phone.trim() || undefined,
        })
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err) => !cancelled && setPreviewError(err instanceof Error ? err.message : "Could not price the bill"));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [order.id, order.total, order.serviceChargeRemoved, discount, appliedCoupon, redeemPoints, phone]);

  const payable = preview?.total ?? order.total;

  // Per-bill service-charge removal (permissioned, needs a reason).
  const [scReason, setScReason] = useState<string | null>(null);
  const changeServiceCharge = async (remove: boolean) => {
    setError(null);
    try {
      const updated = remove
        ? await api.removeServiceCharge(order.id, (scReason ?? "").trim())
        : await api.restoreServiceCharge(order.id);
      setOrder(updated);
      setScReason(null);
      setSplit({ CASH: 0, CARD: 0, UPI: 0, WALLET: 0, OTHER: 0, GIFT_CARD: 0 });
      onOrderChanged?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the service charge");
    }
  };

  const paid = useMemo(() => Object.values(split).reduce((s, n) => s + n, 0), [split]);
  const remaining = Math.round((payable - paid) * 100) / 100;

  const setMode = (mode: PaymentMode, amount: number) =>
    setSplit((prev) => ({ ...prev, [mode]: Math.max(0, amount) }));
  const payFull = (mode: PaymentMode) =>
    setSplit({ CASH: 0, CARD: 0, UPI: 0, WALLET: 0, OTHER: 0, GIFT_CARD: split.GIFT_CARD, [mode]: Math.max(0, Math.round((payable - split.GIFT_CARD) * 100) / 100) });

  const checkGiftCard = async () => {
    const code = gcCode.trim();
    if (!code) return;
    setGcMsg(null);
    try {
      const info = await hrApi.giftCardBalance(outletId, code);
      setGcInfo(info);
      if (!info.usable) {
        setGcMsg(info.reason ?? "Card cannot be used");
        setMode("GIFT_CARD", 0);
        return;
      }
      const others = MODES.reduce((s, m) => s + split[m], 0);
      const use = Math.min(info.balance, Math.max(0, Math.round((payable - others) * 100) / 100));
      setMode("GIFT_CARD", use);
      setGcMsg(`Balance ₹${info.balance.toFixed(2)}${info.expiresOn ? ` · valid till ${info.expiresOn}` : ""}`);
    } catch (err) {
      setGcInfo(null);
      setGcMsg(err instanceof Error ? err.message : "Could not check card");
    }
  };

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
      setCouponMsg(t("settle.couponFailed"));
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
      publishCfdPayment(null);
      return;
    }
    try {
      const qr = await api.upiQr(outletId, order.id, payable);
      const png = await QRCode.toDataURL(qr.upiString, { margin: 1, width: 180, color: { dark: "#14110f", light: "#f4ede2" } });
      setQrDataUrl(png);
      setQrVpa(qr.payeeVpa);
      publishCfdPayment({ upiString: qr.upiString, amount: qr.amount, payeeVpa: qr.payeeVpa });
    } catch {
      setError(t("settle.qrFailed"));
    }
  };

  const sendOtp = async () => {
    setOtpMsg(null);
    try {
      const res = await api.requestLoyaltyOtp(outletId, phone.trim());
      setOtpSent(true);
      setOtpMsg(t("settle.otpSent", { phone: phone.trim() }));
      void res;
    } catch (err) {
      setOtpMsg(err instanceof Error ? err.message : t("settle.otpFailed"));
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payments: { mode: PaymentMode; amount: number; giftCardCode?: string }[] = MODES.filter((m) => split[m] > 0).map((m) => ({ mode: m, amount: split[m] }));
      if (split.GIFT_CARD > 0) {
        if (!gcInfo?.usable) {
          setError("Check the gift card before using it.");
          setBusy(false);
          return;
        }
        payments.push({ mode: "GIFT_CARD", amount: split.GIFT_CARD, giftCardCode: gcCode.trim() });
      }
      if (payments.length === 0) {
        setError(t("settle.needPayment"));
        setBusy(false);
        return;
      }
      if (redeemPoints > 0 && !otp.trim()) {
        setError(t("settle.needOtp"));
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
      setError(err instanceof Error ? err.message : t("settle.failed"));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal settle-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{order.splitIndex ? `Settle check ${order.splitIndex} of ${order.splitCount ?? "?"}` : t("settle.title")}</h2>
            <span className="settle-sub">
              {t("settle.sub", { where: order.tableName ?? t(`orderType.${order.orderType}` as const), count: order.items.length })}
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
                placeholder={t("settle.phonePlaceholder")}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="numeric"
              />
              {customer?.found && (
                <span className="co-balance">
                  {customer.name ?? t("settle.member")} · {t("settle.points", { count: customer.loyaltyPoints })}
                </span>
              )}
            </div>

            {customer?.found && customer.loyaltyPoints > 0 && (
              <div className="co-redeem">
                <span>{t("settle.redeemPoints")}</span>
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
                    {t("settle.max", { count: maxRedeemable })}
                  </button>
                </div>
              </div>
            )}

            {redeemPoints > 0 && (
              <div className="co-otp">
                <button className="co-apply" onClick={sendOtp}>
                  {otpSent ? t("settle.resendOtp") : t("settle.sendOtp")}
                </button>
                <input
                  placeholder={t("settle.otpPlaceholder")}
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
                placeholder={t("settle.couponPlaceholder")}
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              />
              <button className="co-apply" onClick={applyCoupon}>
                {t("common.apply")}
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
              <span>{t("settle.subtotal")}</span>
              <span>{rupee(order.subtotal)}</span>
            </div>
            <div className="ss-row discount-row">
              <span>{t("settle.manualDiscount")}</span>
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
                <span>{t("settle.coupon", { code: couponCode.trim() })}</span>
                <span>−{rupee(couponDiscount)}</span>
              </div>
            )}
            {redeemDiscount > 0 && (
              <div className="ss-row">
                <span>{t("settle.pointsRedeemed", { count: redeemPoints })}</span>
                <span>−{rupee(redeemDiscount)}</span>
              </div>
            )}
            {preview && (preview.serviceChargeAmount > 0 || preview.serviceChargeRemoved) && (
              <div className="ss-row sc-row">
                <span>
                  {preview.serviceChargeRemoved ? (
                    <>Service charge removed <small className="ss-note">{order.serviceChargeRemovedReason}</small></>
                  ) : (
                    <>
                      Service charge {preview.serviceChargePercent}%
                      {!preview.serviceChargeTaxable && <small className="ss-note">not taxed</small>}
                    </>
                  )}
                  {canRemoveServiceCharge && !preview.serviceChargeRemoved && scReason === null && (
                    <button className="ss-link" onClick={() => setScReason("")}>Remove</button>
                  )}
                  {canRemoveServiceCharge && preview.serviceChargeRemoved && (
                    <button className="ss-link" onClick={() => void changeServiceCharge(false)}>Restore</button>
                  )}
                </span>
                <span>{preview.serviceChargeRemoved ? "—" : rupee(preview.serviceChargeAmount)}</span>
              </div>
            )}
            {scReason !== null && (
              <div className="sc-reason">
                <input
                  autoFocus
                  placeholder="Reason for removing service charge"
                  value={scReason}
                  maxLength={200}
                  onChange={(e) => setScReason(e.target.value)}
                />
                <button className="co-apply" disabled={scReason.trim().length < 3} onClick={() => void changeServiceCharge(true)}>
                  Remove
                </button>
                <button className="co-apply" onClick={() => setScReason(null)}>Keep</button>
              </div>
            )}
            {preview && preview.igst > 0 ? (
              <div className="ss-row">
                <span>IGST</span>
                <span>{rupee(preview.igst)}</span>
              </div>
            ) : (
              <>
                <div className="ss-row">
                  <span>CGST</span>
                  <span>{rupee(preview?.cgst ?? order.cgst)}</span>
                </div>
                <div className="ss-row">
                  <span>SGST</span>
                  <span>{rupee(preview?.sgst ?? order.sgst)}</span>
                </div>
              </>
            )}
            {preview && preview.roundOff !== 0 && (
              <div className="ss-row">
                <span>Round off</span>
                <span>{preview.roundOff > 0 ? "+" : "−"}{rupee(Math.abs(preview.roundOff))}</span>
              </div>
            )}
            {previewError && <p className="co-msg bad">{previewError}</p>}
            <div className="ss-row grand">
              <span>{t("settle.payable")}</span>
              <span>{rupee(payable)}</span>
            </div>
          </div>

          <div className="pay-modes">
            {MODES.map((m) => (
              <div key={m} className="pay-row">
                <button className="pay-full" onClick={() => payFull(m)}>
                  {t(`payMode.${m}` as const)}
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

          <div>
            <div className="gc-tender">
              <input placeholder="Gift card / store credit code" value={gcCode} onChange={(e) => { setGcCode(e.target.value.toUpperCase()); setGcInfo(null); setMode("GIFT_CARD", 0); }} />
              <input
                type="number"
                min={0}
                max={gcInfo?.balance ?? 0}
                value={split.GIFT_CARD || ""}
                placeholder="₹ 0"
                disabled={!gcInfo?.usable}
                onChange={(e) => setMode("GIFT_CARD", Math.min(Number(e.target.value) || 0, gcInfo?.balance ?? 0))}
              />
              <button className="co-apply" type="button" onClick={checkGiftCard} disabled={!gcCode.trim()}>Check</button>
            </div>
            {gcMsg && <p className={`gc-msg co-msg ${gcInfo?.usable ? "ok" : "bad"}`}>{gcMsg}</p>}
          </div>

          <div className="upi-qr-row">
            <button className="co-apply" onClick={showUpiQr} type="button">
              {qrDataUrl ? t("settle.hideQr") : t("settle.showQr")}
            </button>
            {qrDataUrl && (
              <div className="upi-qr">
                <img src={qrDataUrl} alt={t("settle.qrAlt")} width={140} height={140} />
                <span className="upi-qr-vpa">{t("settle.scanToPay", { amount: rupee(payable) })}<br />{qrVpa}</span>
              </div>
            )}
          </div>

          <div className={`remaining ${Math.abs(remaining) < 0.01 ? "settled" : ""}`}>
            {remaining > 0.01 ? (
              <span>{t("settle.remaining", { amount: rupee(remaining) })}</span>
            ) : remaining < -0.01 ? (
              <span>{t("settle.change", { amount: rupee(-remaining) })}</span>
            ) : (
              <span>{t("settle.balanced")}</span>
            )}
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            {t("common.back")}
          </button>
          <button className="btn-primary grow" onClick={submit} disabled={busy || !preview || Math.abs(remaining) > 0.01}>
            {busy ? t("settle.settling") : t("settle.submit", { amount: rupee(payable) })}
          </button>
        </footer>
      </div>
    </div>
  );
}
