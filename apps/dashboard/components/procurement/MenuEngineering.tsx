"use client";

import { useCallback, useEffect, useState } from "react";
import type { MenuClass, MenuEngineeringDto } from "@stello/shared";
import { errMsg, inr, procApi } from "@/lib/procurement-api";
import "./procurement.css";

const CLASSES: { key: MenuClass; title: string; tag: string; blurb: string }[] = [
  { key: "STAR", title: "Stars", tag: "star", blurb: "Popular and profitable — protect them." },
  { key: "PLOWHORSE", title: "Plowhorses", tag: "plow", blurb: "Popular, thin margin — re-cost or reprice." },
  { key: "PUZZLE", title: "Puzzles", tag: "puzzle", blurb: "Profitable, under-ordered — promote them." },
  { key: "DOG", title: "Dogs", tag: "dog", blurb: "Neither — rework or retire." },
];

function dstr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dstr(d);
}

/** Menu engineering (popularity × contribution margin), shown inside Reports. */
export function MenuEngineering({ outletId }: { outletId: string }) {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(dstr(new Date()));
  const [categoryId, setCategoryId] = useState("");
  const [data, setData] = useState<MenuEngineeringDto | null>(null);
  const [filter, setFilter] = useState<MenuClass | "">("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await procApi.menuEngineering(outletId, from, to, categoryId || undefined));
      setError(null);
    } catch (e) {
      setError(errMsg(e, "Failed to load menu engineering"));
    }
  }, [outletId, from, to, categoryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.rows.filter((r) => !filter || r.class === filter) ?? [];

  return (
    <div className="report-card">
      <div className="proc-toolbar">
        <span className="card-title grow" style={{ margin: 0 }}>Menu engineering</span>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {data?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {error && <p className="form-error">{error}</p>}
      {data && (
        <>
          <p className="hint">
            Popular = at least {(data.popularityThreshold * 100).toFixed(1)}% of units sold (70% of an equal share).
            Profitable = contribution margin of at least {inr(data.avgContributionMargin)} (sales-weighted average), using
            recipe food cost at current material cost.
          </p>
          <div className="me-grid">
            {CLASSES.map((c) => {
              const items = data.rows.filter((r) => r.class === c.key);
              return (
                <button
                  key={c.key}
                  className={`me-quad ${c.tag}`}
                  style={{ textAlign: "left", outline: filter === c.key ? "2px solid var(--saffron)" : undefined }}
                  onClick={() => setFilter(filter === c.key ? "" : c.key)}
                >
                  <h3><span>{c.title}</span><span className="mono">{data.counts[c.key]}</span></h3>
                  <p>{c.blurb}</p>
                  <ul>
                    {items.slice(0, 6).map((r) => <li key={r.itemId}>{r.name}</li>)}
                    {items.length > 6 && <li>+{items.length - 6} more</li>}
                  </ul>
                </button>
              );
            })}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th><th>Class</th><th className="num">Sold</th><th className="num">Mix</th>
                <th className="num">Avg price</th><th className="num">Food cost</th><th className="num">Margin / unit</th>
                <th className="num">Total margin</th><th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.itemId}>
                  <td className="strong">{r.name}<span className="unit"> · {r.category}</span></td>
                  <td><span className={`cls-pill ${r.class}`}>{r.class.toLowerCase()}</span></td>
                  <td className="num mono">{r.qty}</td>
                  <td className="num mono faint">{(r.mixPct * 100).toFixed(1)}%</td>
                  <td className="num mono">{inr(r.avgPrice)}</td>
                  <td className="num mono faint">
                    {r.hasRecipe ? inr(r.foodCost) : "no recipe"}
                    {r.foodCostPct !== null && r.hasRecipe && <span className="unit"> ({r.foodCostPct}%)</span>}
                  </td>
                  <td className="num mono">{inr(r.contributionMargin)}</td>
                  <td className="num mono">{inr(r.totalMargin, 0)}</td>
                  <td className="hint-cell">{r.hint}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className="empty">No items in this selection.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
