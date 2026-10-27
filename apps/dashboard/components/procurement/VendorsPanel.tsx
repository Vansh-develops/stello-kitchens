"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PriceHistoryRowDto,
  ProcurementVendorDto,
  SupplierBillDto,
  SupplierPaymentDto,
  VendorPayableDto,
} from "@stello/shared";
import { errMsg, inr, procApi, qty, shortDate } from "@/lib/procurement-api";

const today = () => new Date().toISOString().slice(0, 10);

export function VendorsPanel({ outletId }: { outletId: string }) {
  const [vendors, setVendors] = useState<ProcurementVendorDto[]>([]);
  const [payables, setPayables] = useState<VendorPayableDto[]>([]);
  const [bills, setBills] = useState<SupplierBillDto[]>([]);
  const [payments, setPayments] = useState<SupplierPaymentDto[]>([]);
  const [billFilter, setBillFilter] = useState("UNPAID");
  const [vendorFilter, setVendorFilter] = useState("");
  const [history, setHistory] = useState<PriceHistoryRowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [vendorModal, setVendorModal] = useState<{ vendor: ProcurementVendorDto | null } | null>(null);
  const [billModal, setBillModal] = useState(false);
  const [payModal, setPayModal] = useState<{ vendorId: string; billId?: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [v, p, b, pm] = await Promise.all([
        procApi.vendors(outletId),
        procApi.payables(outletId),
        procApi.bills(outletId, { status: billFilter || undefined, vendorId: vendorFilter || undefined }),
        procApi.payments(outletId, vendorFilter || undefined),
      ]);
      setVendors(v);
      setPayables(p);
      setBills(b);
      setPayments(pm);
      setHistory(vendorFilter ? await procApi.priceHistory(outletId, { vendorId: vendorFilter }) : []);
      setError(null);
    } catch (e) {
      setError(errMsg(e, "Failed to load vendors"));
    }
  }, [outletId, billFilter, vendorFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const payBy = useMemo(() => new Map(payables.map((p) => [p.vendorId, p])), [payables]);
  const totals = useMemo(
    () => ({
      outstanding: payables.reduce((s, p) => s + p.outstanding, 0),
      overdue: payables.reduce((s, p) => s + p.overdue, 0),
    }),
    [payables],
  );

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Vendors &amp; payables</h1>
        <div className="proc-actions">
          <button className="btn-ghost sm" onClick={() => setBillModal(true)} disabled={!vendors.length}>+ Supplier bill</button>
          <button className="btn-ghost sm" onClick={() => vendors[0] && setPayModal({ vendorId: vendorFilter || vendors[0].id })} disabled={!vendors.length}>
            Record payment
          </button>
          <button className="btn-primary sm" onClick={() => setVendorModal({ vendor: null })}>+ Vendor</button>
        </div>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="inv-stats">
        <div className="stat">
          <span className="stat-label">Vendors</span>
          <span className="stat-value">{vendors.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Outstanding</span>
          <span className="stat-value">{inr(totals.outstanding, 0)}</span>
        </div>
        <div className={`stat ${totals.overdue > 0 ? "warn" : ""}`}>
          <span className="stat-label">Overdue</span>
          <span className="stat-value">{inr(totals.overdue, 0)}</span>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Vendor</th><th>Contact</th><th>GSTIN</th><th className="num">Terms</th>
            <th className="num">Outstanding</th><th className="num">Overdue</th><th className="num">Credit</th><th></th>
          </tr>
        </thead>
        <tbody>
          {vendors.map((v) => {
            const p = payBy.get(v.id);
            return (
              <tr key={v.id} className={vendorFilter === v.id ? "low" : ""}>
                <td className="strong">{v.name}</td>
                <td className="faint">{[v.phone, v.email].filter(Boolean).join(" · ") || "—"}</td>
                <td className="mono faint">{v.gstin ?? "—"}</td>
                <td className="num mono faint">{v.paymentTermsDays != null ? `${v.paymentTermsDays}d` : "—"}</td>
                <td className="num mono">{inr(p?.outstanding ?? 0)}</td>
                <td className={`num mono ${(p?.overdue ?? 0) > 0 ? "var-up" : "faint"}`}>{inr(p?.overdue ?? 0)}</td>
                <td className="num mono faint">{inr(p?.credit ?? 0)}</td>
                <td className="row-actions">
                  <button className="text-btn" onClick={() => setVendorFilter(vendorFilter === v.id ? "" : v.id)}>
                    {vendorFilter === v.id ? "All vendors" : "Ledger"}
                  </button>
                  <button className="text-btn" onClick={() => setPayModal({ vendorId: v.id })}>Pay</button>
                  <button className="text-btn" onClick={() => setVendorModal({ vendor: v })}>Edit</button>
                </td>
              </tr>
            );
          })}
          {vendors.length === 0 && <tr><td colSpan={8} className="empty">No vendors yet.</td></tr>}
        </tbody>
      </table>

      <div className="proc-section">
        <div className="proc-toolbar">
          <h2 className="grow" style={{ margin: 0 }}>
            Bills{vendorFilter && ` · ${vendors.find((v) => v.id === vendorFilter)?.name ?? ""}`}
          </h2>
          <select value={billFilter} onChange={(e) => setBillFilter(e.target.value)} aria-label="Bill status">
            <option value="UNPAID">Unpaid</option>
            <option value="">All</option>
            <option value="PAID">Paid</option>
            <option value="VOID">Void</option>
          </select>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Bill</th><th>Vendor</th><th>Date</th><th>Due</th><th>Ref</th>
              <th className="num">Amount</th><th className="num">Outstanding</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id} className={b.overdue ? "low" : ""}>
                <td className="mono strong">{b.billNumber}</td>
                <td>{b.vendorName}</td>
                <td className="faint">{shortDate(b.billDate)}</td>
                <td className={b.overdue ? "var-up" : "faint"}>{shortDate(b.dueDate)}</td>
                <td className="mono faint">{[b.poNumber, b.grnNumber].filter(Boolean).join(" / ") || "—"}</td>
                <td className="num mono">{inr(b.amount)}</td>
                <td className="num mono">{inr(b.outstanding)}</td>
                <td>
                  <span className={`status-pill ${b.status === "PAID" ? "good" : b.status === "VOID" ? "muted" : b.overdue ? "bad" : "info"}`}>
                    {b.overdue ? "overdue" : b.status.toLowerCase()}
                  </span>
                </td>
                <td className="row-actions">
                  {(b.status === "OPEN" || b.status === "PARTIAL") && (
                    <button className="text-btn" onClick={() => setPayModal({ vendorId: b.vendorId, billId: b.id })}>Pay</button>
                  )}
                  {b.status === "OPEN" && (
                    <button
                      className={`text-btn danger ${armed === b.id ? "armed" : ""}`}
                      onClick={async () => {
                        if (armed !== b.id) return setArmed(b.id);
                        try {
                          await procApi.voidBill(outletId, b.id);
                          setArmed(null);
                          void reload();
                        } catch (e) {
                          setError(errMsg(e));
                        }
                      }}
                    >
                      {armed === b.id ? "Confirm void" : "Void"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {bills.length === 0 && <tr><td colSpan={9} className="empty">No bills here.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="proc-two proc-section">
        <section>
          <h2>Payments</h2>
          <table className="data-table">
            <thead>
              <tr><th>Date</th><th>Vendor</th><th>Mode</th><th>Applied to</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="faint">{shortDate(p.paidAt)}</td>
                  <td>{p.vendorName}</td>
                  <td className="mono">{p.mode}{p.reference ? ` · ${p.reference}` : ""}</td>
                  <td className="faint">
                    {p.allocations.map((a) => a.billNumber).join(", ") || "—"}
                    {p.unallocated > 0 && ` (+${inr(p.unallocated)} credit)`}
                  </td>
                  <td className="num mono">{inr(p.amount)}</td>
                </tr>
              ))}
              {payments.length === 0 && <tr><td colSpan={5} className="empty">No payments yet.</td></tr>}
            </tbody>
          </table>
        </section>
        <section>
          <h2>Price history</h2>
          {!vendorFilter && <p className="hint">Open a vendor’s ledger to see what they charged per unit over time.</p>}
          {vendorFilter && (
            <table className="data-table">
              <thead>
                <tr><th>Date</th><th>Material</th><th className="num">Qty</th><th className="num">Paid / unit</th><th className="num">PO / unit</th></tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i}>
                    <td className="faint">{shortDate(h.receivedAt)}</td>
                    <td>{h.materialName}</td>
                    <td className="num mono">{qty(h.quantity)} <span className="unit">{h.unit}</span></td>
                    <td className={`num mono ${h.unitCost > h.poUnitCost ? "var-up" : h.unitCost < h.poUnitCost ? "var-down" : ""}`}>{inr(h.unitCost)}</td>
                    <td className="num mono faint">{inr(h.poUnitCost)}</td>
                  </tr>
                ))}
                {history.length === 0 && <tr><td colSpan={5} className="empty">No receipts from this vendor yet.</td></tr>}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {vendorModal && (
        <VendorModal
          outletId={outletId}
          vendor={vendorModal.vendor}
          onClose={() => setVendorModal(null)}
          onSaved={() => {
            setVendorModal(null);
            void reload();
          }}
        />
      )}
      {billModal && (
        <BillModal
          outletId={outletId}
          vendors={vendors}
          defaultVendorId={vendorFilter || vendors[0]?.id || ""}
          onClose={() => setBillModal(false)}
          onSaved={() => {
            setBillModal(false);
            void reload();
          }}
        />
      )}
      {payModal && (
        <PaymentModal
          outletId={outletId}
          vendors={vendors}
          initial={payModal}
          onClose={() => setPayModal(null)}
          onSaved={() => {
            setPayModal(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function VendorModal({
  outletId,
  vendor,
  onClose,
  onSaved,
}: {
  outletId: string;
  vendor: ProcurementVendorDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: vendor?.name ?? "",
    phone: vendor?.phone ?? "",
    email: vendor?.email ?? "",
    gstin: vendor?.gstin ?? "",
    address: vendor?.address ?? "",
    terms: vendor?.paymentTermsDays != null ? String(vendor.paymentTermsDays) : "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async () => {
    if (!f.name.trim()) return setError("Name is required.");
    setBusy(true);
    setError(null);
    const input = {
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      gstin: f.gstin.trim() || null,
      address: f.address.trim() || null,
      paymentTermsDays: f.terms.trim() ? Number(f.terms) : null,
    };
    try {
      if (vendor) await procApi.updateVendor(outletId, vendor.id, input);
      else await procApi.createVendor(outletId, input);
      onSaved();
    } catch (e) {
      setError(errMsg(e, "Could not save"));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{vendor ? "Edit vendor" : "New vendor"}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <label className="field">Name<input value={f.name} onChange={set("name")} placeholder="Fresh Farms Poultry" /></label>
          <div className="field-row">
            <label className="field">Phone<input value={f.phone} onChange={set("phone")} inputMode="tel" /></label>
            <label className="field short">Terms (days)<input type="number" min="0" value={f.terms} onChange={set("terms")} /></label>
          </div>
          <label className="field">Email<input value={f.email} onChange={set("email")} type="email" /></label>
          <label className="field">GSTIN<input value={f.gstin} onChange={set("gstin")} maxLength={15} /></label>
          <label className="field">Address<input value={f.address} onChange={set("address")} /></label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </footer>
      </div>
    </div>
  );
}

function BillModal({
  outletId,
  vendors,
  defaultVendorId,
  onClose,
  onSaved,
}: {
  outletId: string;
  vendors: ProcurementVendorDto[];
  defaultVendorId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vendorId, setVendorId] = useState(defaultVendorId);
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!billNumber.trim() || !(Number(amount) > 0)) return setError("Bill number and amount are required.");
    setBusy(true);
    setError(null);
    try {
      await procApi.createBill(outletId, {
        vendorId,
        billNumber: billNumber.trim(),
        billDate,
        dueDate: dueDate || null,
        amount: Number(amount),
        note: note.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e, "Could not save"));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Supplier bill</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <p className="hint">Bills for goods received against a PO can be booked straight from the GRN on the Receiving tab.</p>
          <label className="field">
            Vendor
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <div className="field-row">
            <label className="field">Bill / invoice no.<input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} /></label>
            <label className="field short">Amount ₹<input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          </div>
          <div className="field-row">
            <label className="field">Bill date<input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></label>
            <label className="field">Due date<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} placeholder="from vendor terms" /></label>
          </div>
          <label className="field">Note<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Book bill"}</button>
        </footer>
      </div>
    </div>
  );
}

function PaymentModal({
  outletId,
  vendors,
  initial,
  onClose,
  onSaved,
}: {
  outletId: string;
  vendors: ProcurementVendorDto[];
  initial: { vendorId: string; billId?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vendorId, setVendorId] = useState(initial.vendorId);
  const [open, setOpen] = useState<SupplierBillDto[]>([]);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"CASH" | "BANK" | "UPI" | "CHEQUE" | "OTHER">("BANK");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    procApi
      .bills(outletId, { vendorId, status: "UNPAID" })
      .then((b) => {
        setOpen(b);
        const target = initial.billId ? b.find((x) => x.id === initial.billId) : null;
        setAmount(String(target ? target.outstanding : b.reduce((s, x) => s + x.outstanding, 0) || ""));
      })
      .catch((e) => setError(errMsg(e)));
  }, [outletId, vendorId, initial.billId]);

  const submit = async () => {
    const amt = Number(amount);
    if (!(amt > 0)) return setError("Enter an amount.");
    setBusy(true);
    setError(null);
    try {
      const target = initial.billId && vendorId === initial.vendorId ? open.find((b) => b.id === initial.billId) : undefined;
      await procApi.pay(outletId, {
        vendorId,
        amount: amt,
        mode,
        reference: reference.trim() || null,
        paidAt,
        allocations: target ? [{ billId: target.id, amount: Math.min(amt, target.outstanding) }] : undefined,
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e, "Could not record payment"));
      setBusy(false);
    }
  };

  const due = open.reduce((s, b) => s + b.outstanding, 0);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Record payment</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <label className="field">
            Vendor
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <p className="hint">
            {open.length} open bill{open.length === 1 ? "" : "s"} · {inr(due)} outstanding.{" "}
            {initial.billId ? "Applied to the selected bill." : "Applied to the oldest bills first; any excess is kept as credit."}
          </p>
          <div className="field-row">
            <label className="field short">Amount ₹<input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label className="field">
              Mode
              <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                {["BANK", "UPI", "CASH", "CHEQUE", "OTHER"].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field">Reference<input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></label>
            <label className="field">Paid on<input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></label>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Record payment"}</button>
        </footer>
      </div>
    </div>
  );
}
