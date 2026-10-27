"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PurchaseOrderDto } from "@stello/shared";
import { errMsg, inr, procApi, qty, shortDate } from "@/lib/procurement-api";

/** Printable purchase order (browser "Save as PDF" gives the PDF). */
export default function PurchaseOrderPrintPage() {
  return (
    <Suspense fallback={<p style={{ padding: 24 }}>Loading…</p>}>
      <PrintView />
    </Suspense>
  );
}

function PrintView() {
  const params = useSearchParams();
  const outletId = params.get("outlet") ?? "";
  const id = params.get("id") ?? "";
  const [po, setPo] = useState<PurchaseOrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!outletId || !id) return setError("Missing purchase order reference.");
    procApi
      .purchaseOrder(outletId, id)
      .then((p) => {
        setPo(p);
        document.title = `${p.poNumber} · ${p.vendorName}`;
      })
      .catch((e) => setError(errMsg(e, "Could not load the purchase order. Sign in to the console and try again.")));
  }, [outletId, id]);

  if (error) return <p style={{ padding: 24 }}>{error}</p>;
  if (!po) return <p style={{ padding: 24 }}>Loading…</p>;

  const cell: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #ddd", fontSize: 13 };
  const num: React.CSSProperties = { ...cell, textAlign: "right", fontFamily: "var(--mono)" };
  return (
    <div style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <style>{`@media print { .no-print { display: none !important; } @page { margin: 14mm; } }`}</style>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 24px" }}>
        <div className="no-print" style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginBottom: 18 }}>
          <button onClick={() => window.print()} style={{ background: "#111", color: "#fff", padding: "10px 16px", borderRadius: 8 }}>
            Print / Save as PDF
          </button>
        </div>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 24, borderBottom: "2px solid #111", paddingBottom: 14 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{po.outlet.name}</div>
            {po.outlet.address && <div style={{ fontSize: 13 }}>{po.outlet.address}</div>}
            {po.outlet.gstin && <div style={{ fontSize: 13 }}>GSTIN {po.outlet.gstin}</div>}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.04em" }}>PURCHASE ORDER</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 15 }}>{po.poNumber}</div>
            <div style={{ fontSize: 13 }}>Date {shortDate(po.approvedAt ?? po.createdAt)}</div>
            {po.expectedDate && <div style={{ fontSize: 13 }}>Deliver by {shortDate(po.expectedDate)}</div>}
            {po.status === "DRAFT" && <div style={{ fontSize: 12, color: "#b23a32", fontWeight: 600 }}>DRAFT — NOT APPROVED</div>}
            {po.status === "CANCELLED" && <div style={{ fontSize: 12, color: "#b23a32", fontWeight: 600 }}>CANCELLED</div>}
          </div>
        </header>
        <section style={{ margin: "16px 0", fontSize: 13 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#666" }}>Vendor</div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{po.vendor.name}</div>
          {po.vendor.address && <div>{po.vendor.address}</div>}
          {[po.vendor.phone, po.vendor.email].filter(Boolean).length > 0 && <div>{[po.vendor.phone, po.vendor.email].filter(Boolean).join(" · ")}</div>}
          {po.vendor.gstin && <div>GSTIN {po.vendor.gstin}</div>}
          {po.vendor.paymentTermsDays != null && <div>Payment terms: {po.vendor.paymentTermsDays} days</div>}
        </section>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f3f3f3" }}>
              <th style={{ ...cell, textAlign: "left" }}>#</th>
              <th style={{ ...cell, textAlign: "left" }}>Item</th>
              <th style={num}>Qty</th>
              <th style={{ ...cell, textAlign: "left" }}>Unit</th>
              <th style={num}>Rate</th>
              <th style={num}>GST</th>
              <th style={num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l, i) => (
              <tr key={l.id}>
                <td style={cell}>{i + 1}</td>
                <td style={cell}>{l.materialName}</td>
                <td style={num}>{qty(l.orderedQty)}</td>
                <td style={cell}>{l.unit}</td>
                <td style={num}>{inr(l.rate)}</td>
                <td style={num}>{l.taxRate}%</td>
                <td style={num}>{inr(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <table style={{ borderCollapse: "collapse", minWidth: 260 }}>
            <tbody>
              <tr><td style={cell}>Subtotal</td><td style={num}>{inr(po.subtotal)}</td></tr>
              <tr><td style={cell}>GST</td><td style={num}>{inr(po.taxAmount)}</td></tr>
              <tr><td style={{ ...cell, fontWeight: 700 }}>Total</td><td style={{ ...num, fontWeight: 700 }}>{inr(po.total)}</td></tr>
            </tbody>
          </table>
        </div>
        {po.note && <p style={{ fontSize: 13, marginTop: 18 }}><strong>Note:</strong> {po.note}</p>}
        <footer style={{ display: "flex", justifyContent: "space-between", marginTop: 56, fontSize: 12, color: "#444" }}>
          <span>Please quote {po.poNumber} on your invoice and delivery challan.</span>
          <span style={{ borderTop: "1px solid #111", paddingTop: 6, minWidth: 180, textAlign: "center" }}>Authorised signatory</span>
        </footer>
      </div>
    </div>
  );
}
