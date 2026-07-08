"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { InvoiceDto, InvoiceRowDto } from "@stello/shared";
import { api } from "@/lib/api";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

function dstr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const statusTone: Record<string, string> = { GENERATED: "good", PENDING: "muted", CANCELLED: "bad" };

export function AccountingTab({ outletId }: { outletId: string }) {
  const [invoices, setInvoices] = useState<InvoiceRowDto[]>([]);
  const [detail, setDetail] = useState<InvoiceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  const to = dstr(new Date());
  const from = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    return dstr(d);
  }, [days]);

  const reload = useCallback(async () => {
    try {
      setInvoices(await api.invoices(outletId, from, to));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invoices");
    }
  }, [outletId, from, to]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const totals = useMemo(
    () => ({
      taxable: invoices.reduce((s, i) => s + i.taxableValue, 0),
      tax: invoices.reduce((s, i) => s + i.cgst + i.sgst, 0),
      generated: invoices.filter((i) => i.hasIrn).length,
    }),
    [invoices],
  );

  const downloadTally = async () => {
    try {
      const res = await api.tallyExport(outletId, from, to);
      const blob = new Blob([res.xml], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    }
  };

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Accounting</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="range-tabs">
            {[7, 30, 90].map((d) => (
              <button key={d} className={`range-tab ${days === d ? "active" : ""}`} onClick={() => setDays(d)}>
                {d}d
              </button>
            ))}
          </div>
          <button className="btn-primary sm" onClick={downloadTally}>Export to Tally (XML)</button>
        </div>
      </div>
      <p className="hint wide">
        GST invoices for settled orders. Generate an IRN + signed QR through the GSP (e-invoicing), and export
        ledger-mapped sales vouchers to Tally. E-invoices are immutable once generated.
      </p>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="inv-stats">
        <div className="stat"><span className="stat-label">Invoices</span><span className="stat-value">{invoices.length}</span></div>
        <div className="stat"><span className="stat-label">Taxable value</span><span className="stat-value">{money(totals.taxable)}</span></div>
        <div className="stat"><span className="stat-label">GST (C+S)</span><span className="stat-value">{money(totals.tax)}</span></div>
        <div className="stat"><span className="stat-label">e-Invoiced</span><span className="stat-value seg-good">{totals.generated}</span></div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Date</th>
            <th>Customer</th>
            <th className="num">Taxable</th>
            <th className="num">CGST</th>
            <th className="num">SGST</th>
            <th className="num">Total</th>
            <th>e-Invoice</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.orderId}>
              <td className="strong mono">{i.invoiceNumber}</td>
              <td className="faint">{date(i.invoiceDate)}</td>
              <td>{i.customerName ?? <span className="faint">Walk-in</span>}</td>
              <td className="num mono">{money(i.taxableValue)}</td>
              <td className="num mono">{money(i.cgst)}</td>
              <td className="num mono">{money(i.sgst)}</td>
              <td className="num mono strong">{money(i.total)}</td>
              <td><span className={`status-pill ${statusTone[i.status]}`}>{i.hasIrn ? "IRN" : i.status}</span></td>
              <td className="row-actions">
                <button className="text-btn" onClick={() => void api.invoice(outletId, i.orderId).then(setDetail)}>View</button>
              </td>
            </tr>
          ))}
          {invoices.length === 0 && <tr><td colSpan={9} className="empty">No invoices in range.</td></tr>}
        </tbody>
      </table>

      {detail && (
        <InvoiceModal
          outletId={outletId}
          invoice={detail}
          onClose={() => setDetail(null)}
          onChanged={async () => {
            setDetail(await api.invoice(outletId, detail.orderId));
            void reload();
          }}
        />
      )}
    </div>
  );
}

function InvoiceModal({
  outletId,
  invoice,
  onClose,
  onChanged,
}: {
  outletId: string;
  invoice: InvoiceDto;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [buyerGstin, setBuyerGstin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (invoice.signedQr) {
      void QRCode.toDataURL(invoice.signedQr, { margin: 1, width: 160, color: { dark: "#14110f", light: "#f4ede2" } }).then(setQr);
    } else {
      setQr(null);
    }
  }, [invoice.signedQr]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.generateIrn(outletId, invoice.orderId, buyerGstin.trim() || undefined);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate IRN");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Tax invoice {invoice.invoiceNumber}</h2>
            <span className="settle-sub">
              {new Date(invoice.invoiceDate).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · {invoice.customerName ?? "Walk-in"}
            </span>
          </div>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <div className="inv-gstin">
            <div><span className="ze-label">Seller GSTIN</span><strong className="mono">{invoice.sellerGstin ?? "—"}</strong></div>
            <div><span className="ze-label">Buyer GSTIN</span><strong className="mono">{invoice.buyerGstin ?? "—"}</strong></div>
            <div><span className="ze-label">Place of supply</span><strong className="mono">{invoice.placeOfSupply ?? "—"}</strong></div>
          </div>

          <section className="editor-section">
            <h3>HSN / SAC summary</h3>
            <table className="mini-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "left", fontSize: 10 }}>HSN/SAC</th>
                  <th style={{ textAlign: "right", fontSize: 10 }}>Taxable</th>
                  <th style={{ textAlign: "right", fontSize: 10 }}>Rate</th>
                  <th style={{ textAlign: "right", fontSize: 10 }}>CGST</th>
                  <th style={{ textAlign: "right", fontSize: 10 }}>SGST</th>
                </tr>
              </thead>
              <tbody>
                {invoice.hsnSummary.map((h) => (
                  <tr key={h.hsn + h.rate}>
                    <td className="mono">{h.hsn}</td>
                    <td className="num mono">{money(h.taxable)}</td>
                    <td className="num mono faint">{h.rate}%</td>
                    <td className="num mono">{money(h.cgst)}</td>
                    <td className="num mono">{money(h.sgst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tax-rows" style={{ marginTop: 12 }}>
              <div><span>Taxable value</span><span className="mono">{money(invoice.taxableValue)}</span></div>
              <div><span>CGST + SGST</span><span className="mono">{money(invoice.cgst + invoice.sgst)}</span></div>
              <div className="tax-total"><span>Invoice total</span><span className="mono">{money(invoice.total)}</span></div>
            </div>
          </section>

          <section className="editor-section">
            <h3>E-invoice (IRN)</h3>
            {invoice.irn ? (
              <div className="irn-block">
                <div className="irn-info">
                  <div><span className="ze-label">IRN</span><code className="irn-value">{invoice.irn}</code></div>
                  <div><span className="ze-label">Ack no.</span><strong className="mono">{invoice.ackNo}</strong></div>
                  <div><span className="ze-label">Ack date</span><strong className="mono">{invoice.ackDate ? new Date(invoice.ackDate).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—"}</strong></div>
                  <span className={`status-pill ${statusTone[invoice.status]}`}>{invoice.status}</span>
                </div>
                {qr && <img className="irn-qr" src={qr} alt="Signed e-invoice QR" width={150} height={150} />}
              </div>
            ) : (
              <div className="irn-generate">
                <p className="hint">No IRN yet. Submit to the IRP via the GSP to get an IRN + signed QR.</p>
                <div className="field-row">
                  <input placeholder="Buyer GSTIN (optional, B2B)" value={buyerGstin} onChange={(e) => setBuyerGstin(e.target.value)} />
                  <button className="btn-primary" onClick={generate} disabled={busy}>
                    {busy ? "Generating…" : "Generate IRN"}
                  </button>
                </div>
              </div>
            )}
            {error && <p className="form-error">{error}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
