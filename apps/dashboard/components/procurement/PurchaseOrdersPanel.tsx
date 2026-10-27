"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  lineAmountsPaise,
  purchaseUnitsFor,
  unitFactor,
  type MaterialUnit,
  type PoAction,
  type PoStatus,
  type ProcurementVendorDto,
  type PurchaseOrderDto,
  type PurchaseOrderSummaryDto,
  type RawMaterialDto,
} from "@stello/shared";
import { errMsg, inr, procApi, qty, shortDate } from "@/lib/procurement-api";

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  DRAFT: "Draft",
  APPROVED: "Approved",
  SENT: "Sent",
  PARTIALLY_RECEIVED: "Partly received",
  RECEIVED: "Received",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};
const STATUS_TONE: Record<PoStatus, string> = {
  DRAFT: "muted",
  APPROVED: "info",
  SENT: "info",
  PARTIALLY_RECEIVED: "info",
  RECEIVED: "good",
  CLOSED: "muted",
  CANCELLED: "bad",
};
const ACTION_LABEL: Record<PoAction, string> = { approve: "Approve", send: "Mark sent", cancel: "Cancel PO", close: "Close PO" };

export function PoStatusPill({ status }: { status: PoStatus }) {
  return <span className={`status-pill ${STATUS_TONE[status]}`}>{PO_STATUS_LABEL[status]}</span>;
}

export function PurchaseOrdersPanel({ outletId, onReceive }: { outletId: string; onReceive: (poId: string) => void }) {
  const [list, setList] = useState<PurchaseOrderSummaryDto[]>([]);
  const [status, setStatus] = useState("");
  const [vendors, setVendors] = useState<ProcurementVendorDto[]>([]);
  const [materials, setMaterials] = useState<RawMaterialDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ po: PurchaseOrderDto | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [l, v, m] = await Promise.all([
        procApi.purchaseOrders(outletId, status || undefined),
        procApi.vendors(outletId),
        procApi.materials(outletId),
      ]);
      setList(l);
      setVendors(v);
      setMaterials(m);
      setError(null);
    } catch (e) {
      setError(errMsg(e, "Failed to load purchase orders"));
    }
  }, [outletId, status]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openValue = useMemo(
    () => list.filter((p) => ["APPROVED", "SENT", "PARTIALLY_RECEIVED"].includes(p.status)).reduce((s, p) => s + p.total, 0),
    [list],
  );

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Purchase orders</h1>
        <button className="btn-primary sm" onClick={() => setEditor({ po: null })} disabled={!vendors.length}>
          + New PO
        </button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {!vendors.length && <p className="hint">Add a vendor under “Vendors &amp; payables” before raising a PO.</p>}

      <div className="inv-stats">
        <div className="stat">
          <span className="stat-label">Drafts awaiting approval</span>
          <span className="stat-value">{list.filter((p) => p.status === "DRAFT").length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Open (to receive)</span>
          <span className="stat-value">{list.filter((p) => ["APPROVED", "SENT", "PARTIALLY_RECEIVED"].includes(p.status)).length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Open value</span>
          <span className="stat-value">{inr(openValue, 0)}</span>
        </div>
      </div>

      <div className="proc-toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {(Object.keys(PO_STATUS_LABEL) as PoStatus[]).map((s) => (
            <option key={s} value={s}>{PO_STATUS_LABEL[s]}</option>
          ))}
        </select>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>PO</th>
            <th>Vendor</th>
            <th>Status</th>
            <th>Expected</th>
            <th>Received</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id} className="clickable" onClick={() => setOpenId(p.id)}>
              <td className="mono strong">{p.poNumber}</td>
              <td>{p.vendorName}</td>
              <td><PoStatusPill status={p.status} /></td>
              <td className="faint">{shortDate(p.expectedDate)}</td>
              <td>
                <div className="progress" title={`${p.receivedPct}% received`}>
                  <span style={{ width: `${p.receivedPct}%` }} />
                </div>
              </td>
              <td className="num mono">{inr(p.total)}</td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr><td colSpan={6} className="empty">No purchase orders yet.</td></tr>
          )}
        </tbody>
      </table>

      {editor && (
        <PoEditor
          outletId={outletId}
          po={editor.po}
          vendors={vendors}
          materials={materials}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null);
            setOpenId(id);
            void reload();
          }}
        />
      )}
      {openId && !editor && (
        <PoDetail
          outletId={outletId}
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void reload()}
          onEdit={(po) => setEditor({ po })}
          onReceive={() => onReceive(openId)}
        />
      )}
    </div>
  );
}

type LineDraft = { rawMaterialId: string; quantity: string; unit: MaterialUnit; rate: string; taxRate: string };

export function PoEditor({
  outletId,
  po,
  vendors,
  materials,
  onClose,
  onSaved,
}: {
  outletId: string;
  po: PurchaseOrderDto | null;
  vendors: ProcurementVendorDto[];
  materials: RawMaterialDto[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [vendorId, setVendorId] = useState(po?.vendorId ?? vendors[0]?.id ?? "");
  const [expectedDate, setExpectedDate] = useState(po?.expectedDate?.slice(0, 10) ?? "");
  const [note, setNote] = useState(po?.note ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    po?.lines.map((l) => ({
      rawMaterialId: l.rawMaterialId,
      quantity: String(l.orderedQty),
      unit: l.unit,
      rate: String(l.rate),
      taxRate: String(l.taxRate),
    })) ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);

  const addLine = () => {
    const m = materials.find((x) => !lines.some((l) => l.rawMaterialId === x.id)) ?? materials[0];
    if (!m) return;
    setLines((ls) => [...ls, { rawMaterialId: m.id, quantity: "", unit: m.unit, rate: String(m.costPerUnit), taxRate: "0" }]);
  };
  const patch = (i: number, p: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const totals = useMemo(() => {
    let base = 0;
    let tax = 0;
    for (const l of lines) {
      const a = lineAmountsPaise(Number(l.quantity) || 0, Number(l.rate) || 0, Number(l.taxRate) || 0);
      base += a.basePaise;
      tax += a.taxPaise;
    }
    return { base: base / 100, tax: tax / 100 };
  }, [lines]);

  const submit = async () => {
    const parsed = lines.map((l) => ({
      rawMaterialId: l.rawMaterialId,
      quantity: Number(l.quantity),
      unit: l.unit,
      rate: Number(l.rate) || 0,
      taxRate: Number(l.taxRate) || 0,
    }));
    if (!vendorId) return setError("Pick a vendor.");
    if (!parsed.length) return setError("Add at least one line.");
    if (parsed.some((l) => !(l.quantity > 0))) return setError("Every line needs a quantity.");
    setBusy(true);
    setError(null);
    try {
      const input = { vendorId, expectedDate: expectedDate || null, note: note.trim() || null, lines: parsed };
      if (po) {
        await procApi.updatePurchaseOrder(outletId, po.id, input);
        onSaved(po.id);
      } else {
        const res = await procApi.createPurchaseOrder(outletId, input);
        onSaved(res.id);
      }
    } catch (e) {
      setError(errMsg(e, "Could not save"));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{po ? `Edit ${po.poNumber}` : "New purchase order"}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <div className="field-row">
            <label className="field">
              Vendor
              <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="field">
              Expected delivery
              <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </label>
          </div>
          <div className="proc-lines">
            <div className="proc-line head">
              <span>Material</span><span>Qty</span><span>Unit</span><span>Rate ₹</span><span>GST %</span><span className="mono">Amount</span><span />
            </div>
            {lines.map((l, i) => {
              const m = matById.get(l.rawMaterialId);
              const amount = ((Number(l.quantity) || 0) * (Number(l.rate) || 0));
              return (
                <div className="proc-line" key={i}>
                  <select
                    value={l.rawMaterialId}
                    onChange={(e) => {
                      const nm = matById.get(e.target.value);
                      if (nm) patch(i, { rawMaterialId: nm.id, unit: nm.unit, rate: String(nm.costPerUnit) });
                    }}
                  >
                    {materials.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <input type="number" min="0" step="any" value={l.quantity} placeholder="0" onChange={(e) => patch(i, { quantity: e.target.value })} />
                  <select
                    value={l.unit}
                    onChange={(e) => {
                      const unit = e.target.value as MaterialUnit;
                      const f = m ? unitFactor(unit, m.unit) : 1;
                      // Re-express the rate per new unit (₹/KG → ₹/G etc.).
                      const fOld = m ? unitFactor(l.unit, m.unit) : 1;
                      const rate = f && fOld ? (Number(l.rate) || 0) * (f / fOld) : Number(l.rate);
                      patch(i, { unit, rate: String(Math.round(rate * 10000) / 10000) });
                    }}
                  >
                    {(m ? purchaseUnitsFor(m.unit) : [l.unit]).map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <input type="number" min="0" step="any" value={l.rate} onChange={(e) => patch(i, { rate: e.target.value })} />
                  <select value={l.taxRate} onChange={(e) => patch(i, { taxRate: e.target.value })}>
                    {["0", "5", "12", "18", "28"].map((t) => <option key={t} value={t}>{t}%</option>)}
                  </select>
                  <span className="mono">{inr(amount)}</span>
                  <button className="text-btn danger" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button>
                </div>
              );
            })}
            <div>
              <button className="btn-ghost sm" onClick={addLine} disabled={!materials.length}>+ Add line</button>
            </div>
          </div>
          <div className="proc-totals">
            <span>Subtotal <strong>{inr(totals.base)}</strong></span>
            <span>GST <strong>{inr(totals.tax)}</strong></span>
            <span>Total <strong>{inr(totals.base + totals.tax)}</strong></span>
          </div>
          <label className="field">
            Note to vendor
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Deliver before 10am, rear entrance" />
          </label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : po ? "Save draft" : "Create draft"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PoDetail({
  outletId,
  id,
  onClose,
  onChanged,
  onEdit,
  onReceive,
}: {
  outletId: string;
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onEdit: (po: PurchaseOrderDto) => void;
  onReceive: () => void;
}) {
  const [po, setPo] = useState<PurchaseOrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<PoAction | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      setPo(await procApi.purchaseOrder(outletId, id));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [outletId, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: PoAction) => {
    if ((action === "cancel" || action === "close") && armed !== action) return setArmed(action);
    try {
      await procApi.poAction(outletId, id, { action, reason: reason.trim() || undefined });
      setArmed(null);
      setReason("");
      onChanged();
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const shareText = po
    ? `Purchase order ${po.poNumber} from ${po.outlet.name}\n` +
      po.lines.map((l) => `• ${l.materialName}: ${qty(l.orderedQty)} ${l.unit} @ ₹${l.rate}`).join("\n") +
      `\nTotal: ${inr(po.total)}` +
      (po.expectedDate ? `\nDeliver by ${shortDate(po.expectedDate)}` : "")
    : "";
  const waPhone = po?.vendor.phone?.replace(/\D/g, "");

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{po ? `${po.poNumber} · ${po.vendorName}` : "Purchase order"}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}
          {!po && !error && <p className="hint">Loading…</p>}
          {po && (
            <>
              <div className="proc-meta">
                <span><PoStatusPill status={po.status} /></span>
                <span>Raised <b>{shortDate(po.createdAt)}</b></span>
                <span>Expected <b>{shortDate(po.expectedDate)}</b></span>
                {po.approvedAt && <span>Approved <b>{shortDate(po.approvedAt)}</b></span>}
                {po.sentAt && <span>Sent <b>{shortDate(po.sentAt)}</b></span>}
                {po.overReceiptPct > 0 && <span>Over-receipt tolerance <b>{po.overReceiptPct}%</b></span>}
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Material</th>
                    <th className="num">Ordered</th>
                    <th className="num">Received</th>
                    <th className="num">Rate</th>
                    <th className="num">GST</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="strong">
                        {l.materialName}
                        {l.unit !== l.materialUnit && <span className="unit"> · stocked in {l.materialUnit}</span>}
                      </td>
                      <td className="num mono">{qty(l.orderedQty)} <span className="unit">{l.unit}</span></td>
                      <td className="num mono">{qty(l.receivedQty)}</td>
                      <td className="num mono">{inr(l.rate)}</td>
                      <td className="num mono faint">{l.taxRate}%</td>
                      <td className="num mono">{inr(l.amount + l.taxAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="proc-totals">
                <span>Subtotal <strong>{inr(po.subtotal)}</strong></span>
                <span>GST <strong>{inr(po.taxAmount)}</strong></span>
                <span>Total <strong>{inr(po.total)}</strong></span>
              </div>
              {po.note && <p className="hint">Note: {po.note}</p>}

              {po.receipts.length > 0 && (
                <div>
                  <span className="card-title">Goods receipts</span>
                  <table className="data-table">
                    <thead>
                      <tr><th>GRN</th><th>Date</th><th>Invoice</th><th className="num">Value</th><th className="num">Price variance</th></tr>
                    </thead>
                    <tbody>
                      {po.receipts.map((r) => (
                        <tr key={r.id}>
                          <td className="mono">{r.grnNumber}</td>
                          <td className="faint">{shortDate(r.receivedAt)}</td>
                          <td>{r.invoiceNo ?? "—"}</td>
                          <td className="num mono">{inr(r.total)}</td>
                          <td className={`num mono ${r.varianceAmount > 0 ? "var-up" : r.varianceAmount < 0 ? "var-down" : ""}`}>
                            {r.varianceAmount === 0 ? "—" : inr(r.varianceAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {(armed === "cancel" || armed === "close") && (
                <label className="field">
                  Reason (optional)
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={armed === "close" ? "Vendor can't supply the balance" : "Ordered by mistake"} />
                </label>
              )}
            </>
          )}
        </div>
        {po && (
          <footer className="modal-foot proc-actions">
            {po.status === "DRAFT" && <button className="btn-ghost" onClick={() => onEdit(po)}>Edit</button>}
            <a className="btn-ghost" href={`/console/purchase-order?outlet=${outletId}&id=${po.id}`} target="_blank" rel="noreferrer">
              Print / PDF
            </a>
            {waPhone && po.status !== "DRAFT" && po.status !== "CANCELLED" && (
              <a className="btn-ghost" href={`https://wa.me/${waPhone.length === 10 ? `91${waPhone}` : waPhone}?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer">
                WhatsApp
              </a>
            )}
            {po.allowedActions.map((a) => (
              <button
                key={a}
                className={a === "approve" || a === "send" ? "btn-primary" : `btn-ghost ${armed === a ? "danger" : ""}`}
                onClick={() => void act(a)}
              >
                {armed === a ? `Confirm ${ACTION_LABEL[a].toLowerCase()}` : ACTION_LABEL[a]}
              </button>
            ))}
            {["APPROVED", "SENT", "PARTIALLY_RECEIVED"].includes(po.status) && (
              <button className="btn-primary" onClick={onReceive}>Receive goods</button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
