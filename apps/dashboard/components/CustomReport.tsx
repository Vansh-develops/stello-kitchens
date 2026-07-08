"use client";

import { useState } from "react";
import type { CustomReportDto, ReportDimension, ReportMetric } from "@stello/shared";
import { api } from "@/lib/api";

const DIMENSIONS: { key: ReportDimension; label: string }[] = [
  { key: "item", label: "Item" },
  { key: "category", label: "Category" },
  { key: "orderType", label: "Order type" },
  { key: "paymentMode", label: "Payment mode" },
  { key: "hour", label: "Hour of day" },
  { key: "day", label: "Day" },
];
const METRICS: { key: ReportMetric; label: string }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "orders", label: "Orders" },
  { key: "quantity", label: "Qty sold" },
];

export function CustomReport({ outletId, from, to }: { outletId: string; from: string; to: string }) {
  const [dimension, setDimension] = useState<ReportDimension>("item");
  const [metric, setMetric] = useState<ReportMetric>("revenue");
  const [report, setReport] = useState<CustomReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      setReport(await api.reportCustom(outletId, { from, to, dimension, metric }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build report");
    } finally {
      setBusy(false);
    }
  };

  const fmt = (v: number) =>
    report?.unit === "currency" ? `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : v.toLocaleString("en-IN");
  const max = Math.max(1, ...(report?.rows.map((r) => r.value) ?? [1]));

  return (
    <div className="report-card custom-report">
      <span className="card-title">Custom report builder</span>
      <div className="cr-controls">
        <label>
          Group by
          <select value={dimension} onChange={(e) => setDimension(e.target.value as ReportDimension)}>
            {DIMENSIONS.map((d) => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </select>
        </label>
        <label>
          Measure
          <select value={metric} onChange={(e) => setMetric(e.target.value as ReportMetric)}>
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </label>
        <button className="btn-primary sm" onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run report"}
        </button>
      </div>
      {error && <p className="cr-error">{error}</p>}
      {report && (
        <>
          <div className="cr-total">
            Total <strong>{fmt(report.total)}</strong> across {report.rows.length} · {report.from} → {report.to}
          </div>
          <div className="cr-rows">
            {report.rows.map((r) => (
              <div key={r.key} className="cr-row">
                <span className="cr-label" title={r.label}>{r.label}</span>
                <div className="cr-bar-wrap">
                  <div className="cr-bar" style={{ width: `${(r.value / max) * 100}%` }} />
                </div>
                <span className="cr-value">{fmt(r.value)}</span>
                <span className="cr-share">{(r.share * 100).toFixed(0)}%</span>
              </div>
            ))}
            {report.rows.length === 0 && <p className="empty">No settled sales in this range.</p>}
          </div>
        </>
      )}
      {!report && !error && <p className="hint">Pick a dimension and measure, then run — over the range selected above.</p>}
    </div>
  );
}
