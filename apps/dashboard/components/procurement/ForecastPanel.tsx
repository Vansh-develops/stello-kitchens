"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ForecastAccuracyDto, ForecastDto } from "@stello/shared";
import { errMsg, procApi, qty } from "@/lib/procurement-api";

const dayLabel = (d: string) => {
  const dt = new Date(`${d}T00:00:00`);
  return `${dt.toLocaleDateString("en-IN", { weekday: "short" })} ${dt.getDate()}`;
};
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

export function ForecastPanel({ outletId }: { outletId: string }) {
  const [horizon, setHorizon] = useState(7);
  const [accDays, setAccDays] = useState(14);
  const [fc, setFc] = useState<ForecastDto | null>(null);
  const [acc, setAcc] = useState<ForecastAccuracyDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [f, a] = await Promise.all([procApi.forecast(outletId, horizon), procApi.forecastAccuracy(outletId, accDays)]);
      setFc(f);
      setAcc(a);
      setError(null);
    } catch (e) {
      setError(errMsg(e, "Failed to load forecast"));
    }
  }, [outletId, horizon, accDays]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const maxBar = useMemo(() => Math.max(1, ...(acc?.totals.actual ?? []), ...(acc?.totals.forecast ?? [])), [acc]);

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Demand forecast</h1>
        <div className="range-tabs">
          {[7, 14].map((h) => (
            <button key={h} className={`range-tab ${horizon === h ? "active" : ""}`} onClick={() => setHorizon(h)}>
              Next {h} days
            </button>
          ))}
        </div>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <p className="hint wide">
        Statistical forecast from the last {fc?.lookbackDays ?? "…"} days of sales: day-of-week pattern plus a damped
        trend, exploded into ingredient usage through recipes. It drives the reorder suggestions.
      </p>

      {fc && (
        <>
          <section>
            <span className="card-title">Ingredients · projected usage</span>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="num">On hand</th>
                  {fc.days.map((d) => <th key={d} className="num">{dayLabel(d)}</th>)}
                  <th className="num">Total</th>
                  <th className="num">Days of cover</th>
                </tr>
              </thead>
              <tbody>
                {fc.materials.map((m) => (
                  <tr key={m.rawMaterialId} className={m.daysOfCover !== null && m.daysOfCover < horizon / 2 ? "low" : ""}>
                    <td className="strong">{m.name}</td>
                    <td className="num mono">{qty(m.onHand)} <span className="unit">{m.unit}</span></td>
                    {m.forecast.map((v, i) => <td key={i} className="num mono faint">{qty(v)}</td>)}
                    <td className="num mono">{qty(m.total)}</td>
                    <td className="num mono">{m.daysOfCover === null ? "—" : m.daysOfCover}</td>
                  </tr>
                ))}
                {fc.materials.length === 0 && (
                  <tr><td colSpan={fc.days.length + 4} className="empty">No sales of items with recipes in the history window yet.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="proc-section">
            <span className="card-title">Menu items · projected units</span>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Avg / day</th>
                  {fc.days.map((d) => <th key={d} className="num">{dayLabel(d)}</th>)}
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {fc.items.slice(0, 30).map((it) => (
                  <tr key={it.itemId}>
                    <td className="strong">{it.name}</td>
                    <td className="num mono faint">{it.avgDaily}</td>
                    {it.forecast.map((v, i) => <td key={i} className="num mono">{Math.round(v)}</td>)}
                    <td className="num mono">{Math.round(it.total)}</td>
                  </tr>
                ))}
                {fc.items.length === 0 && <tr><td colSpan={fc.days.length + 3} className="empty">No sales history yet.</td></tr>}
              </tbody>
            </table>
          </section>
        </>
      )}

      {acc && (
        <section className="proc-section">
          <div className="proc-toolbar">
            <h2 className="grow" style={{ margin: 0 }}>Forecast vs actual</h2>
            <div className="range-tabs">
              {[14, 28].map((w) => (
                <button key={w} className={`range-tab ${accDays === w ? "active" : ""}`} onClick={() => setAccDays(w)}>
                  Last {w} days
                </button>
              ))}
            </div>
          </div>
          <div className="inv-stats">
            <div className="stat"><span className="stat-label">Accuracy (1 − WAPE)</span><span className="stat-value">{pct(acc.summary.accuracy)}</span></div>
            <div className="stat"><span className="stat-label">Bias</span><span className="stat-value">{acc.summary.bias === null ? "—" : `${acc.summary.bias > 0 ? "+" : ""}${Math.round(acc.summary.bias * 100)}%`}</span></div>
            <div className="stat"><span className="stat-label">Units sold / forecast</span><span className="stat-value">{Math.round(acc.summary.actual)} / {Math.round(acc.summary.forecast)}</span></div>
          </div>
          <div className="chart-card">
            <span className="card-title">Units per day</span>
            <div className="pair-chart" role="img" aria-label="Forecast versus actual units per day">
              {acc.days.map((d, i) => (
                <div key={d} className="pair-col" title={`${d}: actual ${acc.totals.actual[i]}, forecast ${acc.totals.forecast[i]}`}>
                  <div className="pair-bars">
                    <span className="act" style={{ height: `${(acc.totals.actual[i] / maxBar) * 100}%` }} />
                    <span className="fc" style={{ height: `${(acc.totals.forecast[i] / maxBar) * 100}%` }} />
                  </div>
                  <span className="bar-x">{new Date(`${d}T00:00:00`).getDate()}</span>
                </div>
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: "var(--saffron)" }} />Actual</span>
              <span><i style={{ background: "var(--faint)" }} />Forecast (one day ahead)</span>
            </div>
          </div>
          <div className="proc-two">
            <table className="data-table">
              <thead><tr><th>Item</th><th className="num">Actual</th><th className="num">Forecast</th><th className="num">Accuracy</th></tr></thead>
              <tbody>
                {acc.items.map((r) => (
                  <tr key={r.itemId}>
                    <td>{r.name}</td>
                    <td className="num mono">{Math.round(r.actual)}</td>
                    <td className="num mono faint">{Math.round(r.forecast)}</td>
                    <td className="num mono">{pct(r.accuracy)}</td>
                  </tr>
                ))}
                {acc.items.length === 0 && <tr><td colSpan={4} className="empty">Not enough history yet.</td></tr>}
              </tbody>
            </table>
            <table className="data-table">
              <thead><tr><th>Material</th><th className="num">Consumed</th><th className="num">Forecast</th><th className="num">Accuracy</th></tr></thead>
              <tbody>
                {acc.materials.map((m) => (
                  <tr key={m.rawMaterialId}>
                    <td>{m.name}</td>
                    <td className="num mono">{qty(m.actual)} <span className="unit">{m.unit}</span></td>
                    <td className="num mono faint">{qty(m.forecast)}</td>
                    <td className="num mono">{pct(m.accuracy)}</td>
                  </tr>
                ))}
                {acc.materials.length === 0 && <tr><td colSpan={4} className="empty">No consumption recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
