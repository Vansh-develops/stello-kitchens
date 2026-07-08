"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BreakdownRowDto,
  CashSessionDto,
  DayEndReportDto,
  FraudReportDto,
  OutletKpiDto,
  ReportBreakdownDto,
  ReportOverviewDto,
} from "@stello/shared";
import { api } from "@/lib/api";
import { CustomReport } from "./CustomReport";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function dstr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dstr(d);
}

const RANGES = [
  { key: "today", label: "Today", from: () => dstr(new Date()) },
  { key: "7d", label: "7 days", from: () => daysAgo(6) },
  { key: "30d", label: "30 days", from: () => daysAgo(29) },
] as const;

export function ReportsTab({ outletId }: { outletId: string }) {
  const [rangeKey, setRangeKey] = useState<(typeof RANGES)[number]["key"]>("today");
  const [overview, setOverview] = useState<ReportOverviewDto | null>(null);
  const [breakdown, setBreakdown] = useState<ReportBreakdownDto | null>(null);
  const [dayEnd, setDayEnd] = useState<DayEndReportDto | null>(null);
  const [fraud, setFraud] = useState<FraudReportDto | null>(null);
  const [outlets, setOutlets] = useState<OutletKpiDto[]>([]);
  const [sessions, setSessions] = useState<CashSessionDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const to = dstr(new Date());
  const from = useMemo(() => RANGES.find((r) => r.key === rangeKey)!.from(), [rangeKey]);

  const reload = useCallback(async () => {
    try {
      const [ov, bd, de, fr, os, cs] = await Promise.all([
        api.reportOverview(outletId, from, to),
        api.reportBreakdown(outletId, from, to),
        api.reportDayEnd(outletId, to),
        api.reportFraud(outletId, from, to),
        api.reportOutlets(from, to),
        api.cashSessions(outletId),
      ]);
      setOverview(ov);
      setBreakdown(bd);
      setDayEnd(de);
      setFraud(fr);
      setOutlets(os);
      setSessions(cs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    }
  }, [outletId, from, to]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const maxSales = useMemo(
    () => Math.max(1, ...(overview?.series.map((s) => s.sales) ?? [1])),
    [overview],
  );

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Reports</h1>
        <div className="range-tabs">
          {RANGES.map((r) => (
            <button key={r.key} className={`range-tab ${rangeKey === r.key ? "active" : ""}`} onClick={() => setRangeKey(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      {outlets.length > 1 && (
        <div className="outlet-kpis">
          {outlets.map((o) => (
            <div key={o.outletId} className={`okpi ${o.outletId === outletId ? "current" : ""}`}>
              <span className="okpi-name">{o.outletName.replace("Stello Kitchens - ", "")}</span>
              <span className="okpi-sales">{money(o.grossSales)}</span>
              <span className="okpi-meta">{o.orders} orders · AOV {money(o.avgOrderValue)}</span>
            </div>
          ))}
        </div>
      )}

      {overview && (
        <div className="kpi-row">
          <Kpi label="Gross sales" value={money2(overview.grossSales)} />
          <Kpi label="Orders" value={String(overview.orders)} />
          <Kpi label="Avg order value" value={money2(overview.avgOrderValue)} />
          <Kpi label="Tax collected" value={money2(overview.taxCollected)} />
          <Kpi label="Discounts" value={money2(overview.discountsGiven)} tone="warn" />
          <Kpi label="New customers" value={String(overview.newCustomers)} />
        </div>
      )}

      {overview && overview.series.length > 1 && (
        <div className="chart-card">
          <span className="card-title">Sales by day</span>
          <div className="bar-chart" role="img" aria-label="Daily sales">
            {overview.series.map((s) => (
              <div key={s.date} className="bar-col" title={`${s.date}: ${money(s.sales)} · ${s.orders} orders`}>
                <div className="bar" style={{ height: `${(s.sales / maxSales) * 100}%` }} />
                <span className="bar-x">{s.date.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <CustomReport outletId={outletId} from={from} to={to} />

      <div className="report-grid">
        <div className="report-col">
          {breakdown && <ShareCard title="Payment modes" rows={breakdown.payments} />}
          {breakdown && <ShareCard title="Order types" rows={breakdown.orderTypes} />}
          {breakdown && <ShareCard title="Categories" rows={breakdown.categories} />}
        </div>

        <div className="report-col">
          {breakdown && (
            <div className="report-card">
              <span className="card-title">Top items</span>
              <table className="mini-table">
                <tbody>
                  {breakdown.topItems.map((it) => (
                    <tr key={it.itemName}>
                      <td className="strong">{it.itemName}</td>
                      <td className="faint">{it.category}</td>
                      <td className="num mono">×{it.qty}</td>
                      <td className="num mono">{money(it.revenue)}</td>
                    </tr>
                  ))}
                  {breakdown.topItems.length === 0 && <tr><td className="empty">No sales in range.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {breakdown && (
            <div className="report-card">
              <span className="card-title">GST summary</span>
              <div className="tax-rows">
                <div><span>Taxable value</span><span className="mono">{money2(breakdown.tax.taxableValue)}</span></div>
                <div><span>CGST</span><span className="mono">{money2(breakdown.tax.cgst)}</span></div>
                <div><span>SGST</span><span className="mono">{money2(breakdown.tax.sgst)}</span></div>
                <div className="tax-total"><span>Total tax</span><span className="mono">{money2(breakdown.tax.totalTax)}</span></div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="report-grid">
        {dayEnd && (
          <div className="report-card">
            <span className="card-title">Day-end (Z) · {dayEnd.date}</span>
            <div className="ze-grid">
              <div><span className="ze-label">Orders</span><strong>{dayEnd.orders}</strong></div>
              <div><span className="ze-label">Bills</span><strong className="mono">{dayEnd.firstBill ?? "—"} → {dayEnd.lastBill ?? "—"}</strong></div>
              <div><span className="ze-label">Gross</span><strong className="mono">{money(dayEnd.gross)}</strong></div>
              <div><span className="ze-label">CGST+SGST</span><strong className="mono">{money2(dayEnd.cgst + dayEnd.sgst)}</strong></div>
              <div><span className="ze-label">Discounts</span><strong className="mono">{money(dayEnd.discounts)}</strong></div>
              <div><span className="ze-label">Cancelled</span><strong className={dayEnd.cancelledOrders ? "neg" : ""}>{dayEnd.cancelledOrders}</strong></div>
            </div>
            <div className="ze-pay">
              {dayEnd.payments.map((p) => (
                <span key={p.key} className="ze-chip">{p.label} {money(p.amount)}</span>
              ))}
            </div>
          </div>
        )}

        {sessions.length > 0 && (
          <div className="report-card">
            <span className="card-title">Cash drawers</span>
            <table className="mini-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "left", fontSize: 10 }}>Opened</th>
                  <th style={{ textAlign: "left", fontSize: 10 }}>Status</th>
                  <th style={{ textAlign: "right", fontSize: 10 }}>Expected</th>
                  <th style={{ textAlign: "right", fontSize: 10 }}>Counted</th>
                  <th style={{ textAlign: "right", fontSize: 10 }}>Variance</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="faint">{new Date(s.openedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                    <td><span className={`status-pill ${s.status === "OPEN" ? "info" : "muted"}`}>{s.status}</span></td>
                    <td className="num mono">{money(s.expectedCash)}</td>
                    <td className="num mono">{s.countedCash != null ? money(s.countedCash) : "—"}</td>
                    <td className={`num mono ${s.variance != null && Math.abs(s.variance) > 0.01 ? "neg" : ""}`}>
                      {s.variance != null ? money(s.variance) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {fraud && (
          <div className="report-card">
            <span className="card-title">Fraud &amp; pilferage watch</span>
            <div className="fraud-stats">
              <div><span className="ze-label">Cancelled</span><strong className={fraud.cancelledCount ? "neg" : ""}>{fraud.cancelledCount}</strong></div>
              <div><span className="ze-label">Discounted</span><strong>{fraud.discountedCount}</strong></div>
              <div><span className="ze-label">Given away</span><strong className="mono neg">{money(fraud.discountedValue)}</strong></div>
            </div>
            <ul className="fraud-list">
              {fraud.cancelled.slice(0, 4).map((o, i) => (
                <li key={`c${i}`}><span className="status-pill bad">CANCELLED</span> {o.orderType.replace("_", " ").toLowerCase()} · {money(o.total)}</li>
              ))}
              {fraud.discounted.slice(0, 4).map((o, i) => (
                <li key={`d${i}`}><span className="status-pill info">{o.billNumber}</span> −{money(o.discountAmount)}{o.couponCode ? ` (${o.couponCode})` : ""}</li>
              ))}
              {fraud.cancelledCount === 0 && fraud.discountedCount === 0 && <li className="hint">Nothing flagged in range.</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="kpi-card">
      <span className="kpi-label">{label}</span>
      <span className={`kpi-value ${tone === "warn" ? "warn" : ""}`}>{value}</span>
    </div>
  );
}

function ShareCard({ title, rows }: { title: string; rows: BreakdownRowDto[] }) {
  return (
    <div className="report-card">
      <span className="card-title">{title}</span>
      <div className="share-rows">
        {rows.map((r) => (
          <div key={r.key} className="share-row">
            <div className="share-head">
              <span>{r.label}</span>
              <span className="mono">{money(r.amount)} · {pct(r.share)}</span>
            </div>
            <div className="share-track">
              <div className="share-fill" style={{ width: `${Math.max(2, r.share * 100)}%` }} />
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="empty">No data.</p>}
      </div>
    </div>
  );
}
