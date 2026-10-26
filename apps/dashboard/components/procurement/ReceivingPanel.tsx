"use client";

import { useCallback, useEffect, useState } from "react";
import type { GoodsReceiptDto, ProcurementSettingsDto, PurchaseOrderDto, PurchaseOrderSummaryDto } from "@stello/shared";
import { maxReceivable, priceVariance } from "@stello/shared";
import { errMsg, inr, procApi, qty, shortDate } from "@/lib/procurement-api";
import { PoStatusPill } from "./PurchaseOrdersPanel";

export function ReceivingPanel({
  outletId,
  focusPoId,
  onFocusDone,
}: {
  outletId: string;
  focusPoId: string | null;
  onFocusDone: () => void;
}) {
  const [open, setOpen] = useState<PurchaseOrderSummaryDto[]>([]);
  const [receipts, setReceipts] = useState<GoodsReceiptDto[]>([]);
  const [settings, setSettings] = useState<ProcurementSettingsDto | null>(null);
  const [selected, setSelected] = useState<string | null>(focusPoId);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [all, r, s] = await Promise.all([
        procApi.purchaseOrders(outletId),
        procApi.receipts(outletId),
        procApi.settings(outletId),
      ]);
      setOpen(all.filter((p) => ["APPROVED", "SENT", "PARTIALLY_RECEIVED"].includes(p.status)));
      setReceipts(r);
      setSettings(s);
      setError(null);
    } catch (e) {
      setError(errMsg(e, "Failed to load receiving"));
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (focusPoId) {
      setSelected(focusPoId);
      onFocusDone();
    }
  }, [focusPoId, onFocusDone]);

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Receiving</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {flash && <div className="lowstock-banner" onClick={() => setFlash(null)}>{flash}</div>}
      <p className="hint wide">
        Record a goods receipt (GRN) against an approved PO. Partial deliveries keep the PO open; stock and the
        weighted-average cost update immediately. Direct receipts without a PO stay available on the Stock tab.
      </p>

      <div className="proc-two">
        <section>
          <span className="card-title">Awaiting delivery</span>
          <table className="data-table">
            <thead>
              <tr><th>PO</th><th>Vendor</th><th>Status</th><th>Expected</th><th className="num">Received</th></tr>
            </thead>
            <tbody>
              {open.map((p) => (
                <tr key={p.id} className={`clickable ${selected === p.id ? "low" : ""}`} onClick={() => setSelected(p.id)}>
                  <td className="mono strong">{p.poNumber}</td>
                  <td>{p.vendorName}</td>
                  <td><PoStatusPill status={p.status} /></td>
                  <td className="faint">{shortDate(p.expectedDate)}</td>
                  <td className="num mono">{p.receivedPct}%</td>
                </tr>
              ))}
              {open.length === 0 && <tr><td colSpan={5} className="empty">Nothing to receive. Approve a PO first.</td></tr>}
            </tbody>
          </table>
        </section>
        <section>
          {selected && settings ? (
            <ReceiveForm
              key={selected}
              outletId={outletId}
              poId={selected}
              settings={settings}
              onDone={(msg) => {
                setFlash(msg);
                setSelected(null);
                void reload();
              }}
              onCancel={() => setSelected(null)}
            />
          ) : (
            <div className="side-card"><p className="hint">Pick a PO on the left to record what arrived.</p></div>
          )}
        </section>
      </div>

      <div className="proc-section">
        <h2>Recent goods receipts</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>GRN</th><th>PO</th><th>Vendor</th><th>Date</th><th>Invoice</th>
              <th className="num">Value</th><th className="num">Price variance</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => (
              <tr key={r.id}>
                <td className="mono strong">{r.grnNumber}</td>
                <td className="mono">{r.poNumber}</td>
                <td>{r.vendorName}</td>
                <td className="faint">{shortDate(r.receivedAt)}</td>
                <td>{r.invoiceNo ?? "—"}</td>
                <td className="num mono">{inr(r.total)}</td>
                <td className={`num mono ${r.varianceAmount > 0 ? "var-up" : r.varianceAmount < 0 ? "var-down" : ""}`}>
                  {r.varianceAmount === 0 ? "—" : inr(r.varianceAmount)}
                </td>
              </tr>
            ))}
            {receipts.length === 0 && <tr><td colSpan={7} className="empty">No receipts yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReceiveForm({
  outletId,
  poId,
  settings,
  onDone,
  onCancel,
}: {
  outletId: string;
  poId: string;
  settings: ProcurementSettingsDto;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const [po, setPo] = useState<PurchaseOrderDto | null>(null);
  const [rows, setRows] = useState<Record<string, { qty: string; rate: string }>>({});
  const [invoiceNo, setInvoiceNo] = useState("");
  const [createBill, setCreateBill] = useState(true);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    procApi
      .purchaseOrder(outletId, poId)
      .then((p) => {
        setPo(p);
        setRows(Object.fromEntries(p.lines.map((l) => [l.id, { qty: String(l.pendingQty), rate: String(l.rate) }])));
      })
      .catch((e) => setError(errMsg(e)));
  }, [outletId, poId]);

  const submit = async () => {
    if (!po) return;
    const lines = po.lines
      .map((l) => ({ poLineId: l.id, quantity: Number(rows[l.id]?.qty) || 0, rate: Number(rows[l.id]?.rate) }))
      .filter((l) => l.quantity > 0);
    if (!lines.length) return setError("Enter what arrived on at least one line.");
    if (createBill && !invoiceNo.trim()) return setError("Enter the vendor invoice number, or untick “Book bill”.");
    setBusy(true);
    setError(null);
    try {
      const res = await procApi.receive(outletId, po.id, {
        invoiceNo: invoiceNo.trim() || null,
        note: note.trim() || null,
        lines: lines.map((l) => ({ ...l, rate: Number.isFinite(l.rate) ? l.rate : undefined })),
        createBill,
      });
      onDone(
        `${res.grnNumber} recorded for ${po.poNumber} (${inr(res.total)})` +
          (res.varianceAmount ? ` · price variance ${inr(res.varianceAmount)}` : "") +
          (res.status === "RECEIVED" ? " · PO fully received" : " · PO partly received"),
      );
    } catch (e) {
      setError(errMsg(e, "Could not record receipt"));
      setBusy(false);
    }
  };

  if (!po) return <div className="side-card">{error ? <p className="form-error">{error}</p> : <p className="hint">Loading…</p>}</div>;

  return (
    <div className="side-card">
      <h3>Receive {po.poNumber} · {po.vendorName}</h3>
      <table className="data-table">
        <thead>
          <tr><th>Material</th><th className="num">Pending</th><th className="num">Arrived</th><th className="num">Rate ₹</th></tr>
        </thead>
        <tbody>
          {po.lines.map((l) => {
            const r = rows[l.id] ?? { qty: "", rate: "" };
            const max = maxReceivable(l.orderedQty, l.receivedQty, settings.overReceiptPct);
            const over = (Number(r.qty) || 0) > max + 1e-9;
            const pv = priceVariance(l.rate, Number(r.rate) || 0, 1);
            const alert = pv.pct !== null && Math.abs(pv.pct) >= settings.priceVarianceAlertPct && pv.pct !== 0;
            return (
              <tr key={l.id} className={over ? "low" : ""}>
                <td className="strong">
                  {l.materialName}
                  {alert && <span className={`unit ${pv.pct! > 0 ? "var-up" : "var-down"}`}> · {pv.pct! > 0 ? "+" : ""}{pv.pct}% vs PO</span>}
                  {over && <span className="unit var-up"> · max {qty(max)}</span>}
                </td>
                <td className="num mono">{qty(l.pendingQty)} <span className="unit">{l.unit}</span></td>
                <td className="num">
                  <input
                    className="cell"
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={r.qty}
                    onChange={(e) => setRows((s) => ({ ...s, [l.id]: { ...r, qty: e.target.value } }))}
                  />
                </td>
                <td className="num">
                  <input
                    className="cell"
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={r.rate}
                    onChange={(e) => setRows((s) => ({ ...s, [l.id]: { ...r, rate: e.target.value } }))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="modal-body" style={{ padding: "14px 0 0" }}>
        <div className="field-row">
          <label className="field">
            Vendor invoice no.
            <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="INV-2291" />
          </label>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8, display: "flex", marginTop: 18 }}>
            <input type="checkbox" checked={createBill} onChange={(e) => setCreateBill(e.target.checked)} style={{ width: "auto" }} />
            Book supplier bill
          </label>
        </div>
        <label className="field">
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="2 crates short, rest on Friday" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="proc-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>{busy ? "Recording…" : "Record GRN"}</button>
        </div>
      </div>
    </div>
  );
}
