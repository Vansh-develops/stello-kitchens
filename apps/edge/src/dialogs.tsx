import { useMemo, useState } from "react";
import type { ComboDto, MenuItemDto, PaymentMode } from "@stello/shared";
import { computeOrderTotals, fromPaise, toPaise } from "@stello/shared";
import { edge, type CouponPreview, type EdgeStatus, type LocalOrder, type PaymentInput } from "./api";
import type { CartLine } from "./Pos";

const rupee = (n: number) => `₹${n.toFixed(2)}`;

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Variation + addon picker that enforces each group's min/max like the server does. */
export function ItemDialog({ item, onClose, onAdd }: { item: MenuItemDto; onClose: () => void; onAdd: (l: Omit<CartLine, "key">) => void }) {
  const [variationId, setVariationId] = useState<string | undefined>(item.variations[0]?.id);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");

  const variation = item.variations.find((v) => v.id === variationId);
  const addons = item.addonGroups.flatMap((g) => g.addons).filter((a) => addonIds.includes(a.id));
  const unit = fromPaise(toPaise(variation ? variation.price : item.price) + addons.reduce((s, a) => s + toPaise(a.price), 0));
  const problems = item.addonGroups
    .map((g) => {
      const n = g.addons.filter((a) => addonIds.includes(a.id)).length;
      return n < g.minSelect ? `${g.name}: pick at least ${g.minSelect}` : n > g.maxSelect ? `${g.name}: at most ${g.maxSelect}` : null;
    })
    .filter(Boolean);

  const toggle = (groupMax: number, groupAddonIds: string[], id: string) =>
    setAddonIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      const inGroup = prev.filter((x) => groupAddonIds.includes(x));
      // Single-choice groups behave like radios.
      if (groupMax === 1) return [...prev.filter((x) => !groupAddonIds.includes(x)), id];
      if (inGroup.length >= groupMax) return prev;
      return [...prev, id];
    });

  return (
    <Modal title={item.name} onClose={onClose}>
      {item.variations.length > 0 && (
        <fieldset className="opt-group">
          <legend>Size / variant</legend>
          {item.variations.map((v) => (
            <label key={v.id} className={`opt ${variationId === v.id ? "on" : ""}`}>
              <input type="radio" name="variation" checked={variationId === v.id} onChange={() => setVariationId(v.id)} />
              <span>{v.name}</span>
              <span className="mono">{rupee(v.price)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {item.addonGroups.map((g) => (
        <fieldset key={g.id} className="opt-group">
          <legend>
            {g.name}{" "}
            <span className="faint">
              {g.minSelect > 0 ? `pick ${g.minSelect}${g.maxSelect > g.minSelect ? `–${g.maxSelect}` : ""}` : `up to ${g.maxSelect}`}
            </span>
          </legend>
          {g.addons.map((a) => (
            <label key={a.id} className={`opt ${addonIds.includes(a.id) ? "on" : ""}`}>
              <input type="checkbox" checked={addonIds.includes(a.id)} onChange={() => toggle(g.maxSelect, g.addons.map((x) => x.id), a.id)} />
              <span>{a.name}</span>
              <span className="mono">+{rupee(a.price)}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <label className="field">
        Kitchen note
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. less spicy" />
      </label>
      <div className="modal-foot">
        <span className="eb-step">
          <button onClick={() => setQty((q) => Math.max(1, q - 1))}>–</button>
          <span>{qty}</span>
          <button onClick={() => setQty((q) => q + 1)}>+</button>
        </span>
        {problems.length > 0 && <span className="form-error">{problems[0]}</span>}
        <button
          className="btn-primary"
          disabled={problems.length > 0}
          onClick={() =>
            onAdd({
              label: item.name,
              detail: [variation?.name, ...addons.map((a) => a.name), note && `“${note}”`].filter(Boolean).join(", "),
              unitPrice: unit,
              taxRate: item.taxRate,
              qty,
              item: { itemId: item.id, ...(variationId ? { variationId } : {}), addonIds, ...(note ? { note } : {}) },
            })
          }
        >
          Add · {rupee(fromPaise(toPaise(unit) * qty))}
        </button>
      </div>
    </Modal>
  );
}

export function ComboDialog({ combo, onClose, onAdd }: { combo: ComboDto; onClose: () => void; onAdd: (l: Omit<CartLine, "key">) => void }) {
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(combo.slots.map((s) => [s.id, (s.options.find((o) => o.isDefault && o.inStock) ?? s.options.find((o) => o.inStock) ?? s.options[0])?.itemId ?? ""])),
  );
  const [qty, setQty] = useState(1);
  const picked = combo.slots.map((s) => s.options.find((o) => o.itemId === choice[s.id]));
  const unit = fromPaise(toPaise(combo.price) + picked.reduce((sum, o) => sum + toPaise(o?.priceDelta ?? 0), 0));
  const blocked = picked.some((o) => !o || !o.inStock);

  return (
    <Modal title={combo.name} onClose={onClose}>
      {combo.slots.map((s) => (
        <fieldset key={s.id} className="opt-group">
          <legend>{s.name}</legend>
          {s.options.map((o) => (
            <label key={o.id} className={`opt ${choice[s.id] === o.itemId ? "on" : ""} ${o.inStock ? "" : "out"}`}>
              <input type="radio" name={s.id} disabled={!o.inStock} checked={choice[s.id] === o.itemId} onChange={() => setChoice({ ...choice, [s.id]: o.itemId })} />
              <span>{o.name}</span>
              <span className="mono">{o.inStock ? (o.priceDelta ? `+${rupee(o.priceDelta)}` : "") : "86'd"}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="modal-foot">
        <span className="eb-step">
          <button onClick={() => setQty((q) => Math.max(1, q - 1))}>–</button>
          <span>{qty}</span>
          <button onClick={() => setQty((q) => q + 1)}>+</button>
        </span>
        <button
          className="btn-primary"
          disabled={blocked}
          onClick={() =>
            onAdd({
              label: combo.name,
              detail: picked.map((o) => o?.name).join(", "),
              unitPrice: unit,
              taxRate: combo.taxRate,
              qty,
              combo: { comboId: combo.id, selections: combo.slots.map((s) => ({ slotId: s.id, itemId: choice[s.id] })) },
            })
          }
        >
          Add · {rupee(fromPaise(toPaise(unit) * qty))}
        </button>
      </div>
    </Modal>
  );
}

const PAY_MODES: { key: PaymentMode; label: string; ref?: string }[] = [
  { key: "CASH", label: "Cash" },
  { key: "CARD", label: "Card", ref: "Last 4 / approval code" },
  { key: "UPI", label: "UPI", ref: "UPI ref / UTR" },
  { key: "WALLET", label: "Wallet", ref: "Reference" },
  { key: "OTHER", label: "Other", ref: "Reference" },
];

/**
 * Settlement: manual discount, coupon (checked offline against the cached rule and
 * this terminal's unsynced uses), and any mix of payment modes. Card/UPI are
 * recorded, not charged — the terminal has no payment-gateway link offline.
 */
export function PayDialog({ order, onClose, onSettled }: { order: LocalOrder; onClose: () => void; onSettled: (o: LocalOrder) => void }) {
  const [discount, setDiscount] = useState("");
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<CouponPreview | null>(null);
  const [rows, setRows] = useState<(PaymentInput & { id: number })[]>([{ id: 1, mode: "CASH", amount: order.total }]);
  const [tendered, setTendered] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const manual = Math.max(0, Number(discount) || 0);
  const totals = useMemo(
    () =>
      computeOrderTotals(
        order.lines.map((l) => ({ lineTotalPaise: toPaise(l.lineTotal), taxRatePercent: l.taxRate })),
        fromPaise(toPaise(manual) + toPaise(coupon?.valid ? coupon.discount : 0)),
      ),
    [order.lines, manual, coupon],
  );
  const paidPaise = rows.reduce((s, r) => s + toPaise(Number(r.amount) || 0), 0);
  const remaining = fromPaise(toPaise(totals.total) - paidPaise);
  const cashRow = rows.length === 1 && rows[0].mode === "CASH";
  const change = cashRow && tendered ? fromPaise(toPaise(Number(tendered) || 0) - toPaise(totals.total)) : null;

  // Keep a single payment row in step with the total as discounts change.
  const syncSingle = (total: number) => setRows((r) => (r.length === 1 ? [{ ...r[0], amount: total }] : r));

  const applyCoupon = async () => {
    setError(null);
    if (!couponInput.trim()) return setCoupon(null);
    try {
      const res = await edge.previewCoupon(couponInput.trim(), order.subtotal);
      setCoupon(res);
      const t = computeOrderTotals(
        order.lines.map((l) => ({ lineTotalPaise: toPaise(l.lineTotal), taxRatePercent: l.taxRate })),
        fromPaise(toPaise(manual) + toPaise(res.valid ? res.discount : 0)),
      );
      syncSingle(t.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Coupon check failed");
    }
  };

  const settle = async () => {
    setBusy(true);
    setError(null);
    try {
      const settled = await edge.settle(order.clientId, {
        payments: rows.map((r) => ({ mode: r.mode, amount: Number(r.amount), ...(r.reference ? { reference: r.reference } : {}) })),
        discountAmount: manual || undefined,
        couponCode: coupon?.valid ? coupon.code : null,
      });
      onSettled(settled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not settle");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Settle ${order.tableName ? `Table ${order.tableName}` : order.customerName || "order"}`} onClose={onClose} wide>
      <div className="pay-grid">
        <div>
          <div className="pay-sum">
            <span>Subtotal</span>
            <span>{rupee(totals.subtotal)}</span>
            <span>Discount</span>
            <span>−{rupee(totals.discountAmount)}</span>
            <span>GST</span>
            <span>{rupee(totals.taxAmount)}</span>
            <strong>Total</strong>
            <strong>{rupee(totals.total)}</strong>
          </div>
          <label className="field">
            Discount (₹)
            <input
              inputMode="decimal"
              value={discount}
              onChange={(e) => {
                setDiscount(e.target.value);
                const d = Math.max(0, Number(e.target.value) || 0);
                syncSingle(
                  computeOrderTotals(
                    order.lines.map((l) => ({ lineTotalPaise: toPaise(l.lineTotal), taxRatePercent: l.taxRate })),
                    fromPaise(toPaise(d) + toPaise(coupon?.valid ? coupon.discount : 0)),
                  ).total,
                );
              }}
            />
          </label>
          <div className="field">
            Coupon
            <div className="inline">
              <input value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="CODE" />
              <button className="btn-secondary" onClick={() => void applyCoupon()}>
                Apply
              </button>
            </div>
            {coupon && (
              <span className={coupon.valid ? "ok-text" : "form-error"}>
                {coupon.valid ? `${coupon.code}: −${rupee(coupon.discount)}` : coupon.message}
                {coupon.valid && coupon.limited && " · limited-use coupon: confirmed when this terminal syncs; an overrun is flagged for the manager"}
              </span>
            )}
          </div>
        </div>

        <div>
          {rows.map((r, i) => {
            const meta = PAY_MODES.find((m) => m.key === r.mode)!;
            return (
              <div key={r.id} className="pay-row">
                <select value={r.mode} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, mode: e.target.value as PaymentMode, reference: undefined } : x)))}>
                  {PAY_MODES.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <input inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, amount: e.target.value as unknown as number } : x)))} />
                {meta.ref ? (
                  <input placeholder={meta.ref} value={r.reference ?? ""} maxLength={60} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, reference: e.target.value } : x)))} />
                ) : (
                  <span />
                )}
                {rows.length > 1 ? (
                  <button className="modal-x" onClick={() => setRows(rows.filter((x) => x.id !== r.id))} aria-label="Remove payment">
                    ×
                  </button>
                ) : (
                  <span />
                )}
                {i === 0 && cashRow && (
                  <label className="field tendered">
                    Cash tendered
                    <input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                    {change !== null && change >= 0 && <span className="ok-text">Change {rupee(change)}</span>}
                  </label>
                )}
              </div>
            );
          })}
          <button
            className="btn-ghost"
            onClick={() => setRows([...rows, { id: Date.now(), mode: "UPI", amount: Math.max(0, remaining) }])}
            disabled={remaining <= 0}
          >
            + Split payment
          </button>
          <p className={remaining === 0 ? "ok-text" : "form-error"}>{remaining === 0 ? "Fully paid" : remaining > 0 ? `${rupee(remaining)} still due` : `${rupee(-remaining)} over the total`}</p>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-foot">
        <span className="faint">Card and UPI are recorded only — collect them on your terminal / QR as usual.</span>
        <button className="btn-primary" disabled={busy || remaining !== 0} onClick={() => void settle()}>
          {busy ? "Settling…" : `Settle ${rupee(totals.total)}`}
        </button>
      </div>
    </Modal>
  );
}

export function ReceiptDialog({ order, status, onClose }: { order: LocalOrder; status: EdgeStatus; onClose: () => void }) {
  const number = order.billNo?.number ?? order.offlineRef;
  return (
    <Modal title="Bill settled" onClose={onClose}>
      <div className="receipt" id="receipt">
        <strong>{status.outletName}</strong>
        {status.gstin && <span>GSTIN {status.gstin}</span>}
        <span className="mono">Invoice {number}</span>
        <span>{new Date(order.closedAt ?? order.createdAt).toLocaleString("en-IN")}</span>
        <hr />
        {order.lines.map((l, i) => (
          <div key={i} className="rc-line">
            <span>
              {l.quantity}× {l.itemName}
              {l.variationName ? ` (${l.variationName})` : ""}
            </span>
            <span className="mono">{rupee(l.lineTotal)}</span>
          </div>
        ))}
        <hr />
        <div className="rc-line">
          <span>Subtotal</span>
          <span className="mono">{rupee(order.subtotal)}</span>
        </div>
        {order.discountAmount > 0 && (
          <div className="rc-line">
            <span>Discount{order.couponCode ? ` (${order.couponCode})` : ""}</span>
            <span className="mono">−{rupee(order.discountAmount)}</span>
          </div>
        )}
        <div className="rc-line">
          <span>GST</span>
          <span className="mono">{rupee(order.taxAmount)}</span>
        </div>
        <div className="rc-line total">
          <span>Total</span>
          <span className="mono">{rupee(order.total)}</span>
        </div>
        {order.payments.map((p, i) => (
          <div key={i} className="rc-line faint">
            <span>
              {p.mode}
              {p.reference ? ` · ${p.reference}` : ""}
            </span>
            <span className="mono">{rupee(p.amount)}</span>
          </div>
        ))}
      </div>
      <p className="faint">
        {order.billNo
          ? "This is the tax invoice number from this terminal's own series; it syncs to the cloud unchanged."
          : "Provisional reference — this terminal has no invoice series yet; the cloud assigns the tax invoice number on sync."}
      </p>
      <div className="modal-foot">
        <button className="btn-secondary" onClick={() => window.print()}>
          Print
        </button>
        <button className="btn-primary" onClick={onClose}>
          Next order
        </button>
      </div>
    </Modal>
  );
}
