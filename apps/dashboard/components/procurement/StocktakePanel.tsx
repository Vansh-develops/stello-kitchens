"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StockCountDto, StockCountSummaryDto } from "@stello/shared";
import { errMsg, inr, procApi, qty, shortDate } from "@/lib/procurement-api";

const STATUS_TONE: Record<StockCountSummaryDto["status"], string> = {
  COUNTING: "info",
  SUBMITTED: "info",
  POSTED: "good",
  CANCELLED: "muted",
};

export function StocktakePanel({ outletId }: { outletId: string }) {
  const [counts, setCounts] = useState<StockCountSummaryDto[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scope, setScope] = useState<"FULL" | "CATEGORY">("FULL");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [c, cats] = await Promise.all([procApi.stockCounts(outletId), procApi.stockCountCategories(outletId)]);
      setCounts(c);
      setCategories(cats);
      setCategory((cur) => cur || cats[0] || "");
      setError(null);
    } catch (e) {
      setError(errMsg(e, "Failed to load stock counts"));
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const start = async () => {
    try {
      const res = await procApi.createStockCount(outletId, { scope, category: scope === "CATEGORY" ? category : null });
      await reload();
      setOpenId(res.id);
    } catch (e) {
      setError(errMsg(e, "Could not start a count"));
    }
  };

  if (openId) {
    return (
      <CountSheet
        outletId={outletId}
        id={openId}
        onBack={() => {
          setOpenId(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Stocktake</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <p className="hint wide">
        Starting a count freezes each material’s expected quantity. Count on any phone or tablet, review the
        variances, then a manager posts them as stock adjustments. Sales during the count are kept: only the
        difference between your count and the frozen figure is applied.
      </p>
      <div className="proc-toolbar">
        <select value={scope} onChange={(e) => setScope(e.target.value as "FULL" | "CATEGORY")} aria-label="Count scope">
          <option value="FULL">Full count (all materials)</option>
          <option value="CATEGORY" disabled={!categories.length}>By category</option>
        </select>
        {scope === "CATEGORY" && (
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <button className="btn-primary sm" onClick={() => void start()}>Start count</button>
        {!categories.length && <span className="hint" style={{ margin: 0 }}>Assign material categories on the Reorder tab to count by category.</span>}
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Count</th><th>Scope</th><th>Started</th><th>Status</th>
            <th className="num">Counted</th><th className="num">Variance value</th>
          </tr>
        </thead>
        <tbody>
          {counts.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => setOpenId(c.id)}>
              <td className="mono strong">{c.countNumber}</td>
              <td>{c.scope === "FULL" ? "Full" : c.category}</td>
              <td className="faint">{shortDate(c.startedAt)}</td>
              <td><span className={`status-pill ${STATUS_TONE[c.status]}`}>{c.status.toLowerCase()}</span></td>
              <td className="num mono">{c.countedCount}/{c.lineCount}</td>
              <td className={`num mono ${c.varianceValue < 0 ? "var-up" : c.varianceValue > 0 ? "var-down" : ""}`}>
                {c.status === "POSTED" ? inr(c.varianceValue) : "—"}
              </td>
            </tr>
          ))}
          {counts.length === 0 && <tr><td colSpan={6} className="empty">No stock counts yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function CountSheet({ outletId, id, onBack }: { outletId: string; id: string; onBack: () => void }) {
  const [sc, setSc] = useState<StockCountDto | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [view, setView] = useState<"sheet" | "review">("sheet");
  const [saving, setSaving] = useState<string | null>(null);
  const [armed, setArmed] = useState<"post" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await procApi.stockCount(outletId, id);
      setSc(data);
      setDrafts(Object.fromEntries(data.lines.map((l) => [l.id, l.countedQty === null ? "" : String(l.countedQty)])));
      if (data.status !== "COUNTING") setView("review");
    } catch (e) {
      setError(errMsg(e));
    }
  }, [outletId, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const editable = sc?.status === "COUNTING" || sc?.status === "SUBMITTED";

  const save = async (lineId: string) => {
    if (!sc) return;
    const line = sc.lines.find((l) => l.id === lineId);
    const raw = drafts[lineId]?.trim() ?? "";
    const value = raw === "" ? null : Number(raw);
    if (value !== null && !(value >= 0)) return setError("Counts must be zero or more.");
    if (!line || value === line.countedQty) return;
    setSaving(lineId);
    try {
      await procApi.saveCounts(outletId, id, { entries: [{ lineId, countedQty: value }] });
      setSc((cur) =>
        cur && {
          ...cur,
          lines: cur.lines.map((l) =>
            l.id === lineId
              ? {
                  ...l,
                  countedQty: value,
                  varianceQty: value === null ? null : Math.round((value - l.expectedQty) * 1000) / 1000,
                  varianceValue: value === null ? null : Math.round((value - l.expectedQty) * l.unitCost * 100) / 100,
                }
              : l,
          ),
        },
      );
    } catch (e) {
      setError(errMsg(e, "Could not save count"));
    } finally {
      setSaving(null);
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setArmed(null);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const lines = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (sc?.lines ?? []).filter(
      (l) => (!q || l.materialName.toLowerCase().includes(q)) && (!onlyOpen || l.countedQty === null),
    );
  }, [sc, search, onlyOpen]);
  const variances = useMemo(
    () => (sc?.lines ?? []).filter((l) => l.varianceQty !== null && l.varianceQty !== 0).sort((a, b) => (a.varianceValue ?? 0) - (b.varianceValue ?? 0)),
    [sc],
  );
  const counted = sc?.lines.filter((l) => l.countedQty !== null).length ?? 0;
  const net = (sc?.lines ?? []).reduce((s, l) => s + (l.varianceValue ?? 0), 0);

  if (!sc) return <div className="tab-pane">{error ? <p className="form-error">{error}</p> : <p className="hint">Loading…</p>}</div>;

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>
          <button className="text-btn" onClick={onBack} style={{ marginRight: 10 }}>← Counts</button>
          {sc.countNumber} · {sc.scope === "FULL" ? "Full count" : sc.category}
        </h1>
        <div className="seg">
          <button className={view === "sheet" ? "on" : ""} onClick={() => setView("sheet")} disabled={!editable}>Count sheet</button>
          <button className={view === "review" ? "on" : ""} onClick={() => setView("review")}>Review</button>
        </div>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="inv-stats">
        <div className="stat"><span className="stat-label">Counted</span><span className="stat-value">{counted}/{sc.lines.length}</span></div>
        <div className={`stat ${sc.shrinkageValue < 0 ? "warn" : ""}`}><span className="stat-label">Shrinkage</span><span className="stat-value">{inr(sc.shrinkageValue, 0)}</span></div>
        <div className="stat"><span className="stat-label">Surplus</span><span className="stat-value">{inr(sc.surplusValue, 0)}</span></div>
        <div className="stat"><span className="stat-label">Frozen at</span><span className="stat-value" style={{ fontSize: 14 }}>{new Date(sc.startedAt).toLocaleString("en-IN")}</span></div>
      </div>

      {view === "sheet" && editable && (
        <>
          <div className="proc-toolbar">
            <input className="grow" placeholder="Search material…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} style={{ width: "auto" }} />
              Uncounted only
            </label>
          </div>
          <div className="count-sheet">
            {lines.map((l) => {
              const v = l.varianceQty;
              return (
                <div key={l.id} className={`count-row ${l.countedQty !== null ? "done" : ""}`}>
                  <div>
                    <div className="cr-name">{l.materialName}</div>
                    <div className="cr-sub">
                      expected {qty(l.expectedQty)} {l.unit}
                      {l.category ? ` · ${l.category}` : ""}
                      {l.movedSinceFreeze !== 0 && ` · ${l.movedSinceFreeze > 0 ? "+" : ""}${qty(l.movedSinceFreeze)} moved since freeze`}
                    </div>
                  </div>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    aria-label={`Counted ${l.materialName} in ${l.unit}`}
                    placeholder={l.unit}
                    value={drafts[l.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [l.id]: e.target.value }))}
                    onBlur={() => void save(l.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <div className={`cr-var ${v !== null && v < 0 ? "var-up" : v !== null && v > 0 ? "var-down" : ""}`}>
                    {saving === l.id ? "saving…" : v === null ? "—" : `${v > 0 ? "+" : ""}${qty(v)} ${l.unit}`}
                  </div>
                </div>
              );
            })}
            {lines.length === 0 && <p className="empty">Nothing matches.</p>}
          </div>
        </>
      )}

      {view === "review" && (
        <>
          <span className="card-title">Variances · net {inr(net)}</span>
          <table className="data-table">
            <thead>
              <tr>
                <th>Material</th><th className="num">Expected</th><th className="num">Counted</th>
                <th className="num">Variance</th><th className="num">Value</th><th className="num">Moved since freeze</th>
              </tr>
            </thead>
            <tbody>
              {variances.map((l) => (
                <tr key={l.id}>
                  <td className="strong">{l.materialName}</td>
                  <td className="num mono">{qty(l.expectedQty)} <span className="unit">{l.unit}</span></td>
                  <td className="num mono">{qty(l.countedQty ?? 0)}</td>
                  <td className={`num mono ${(l.varianceQty ?? 0) < 0 ? "var-up" : "var-down"}`}>{(l.varianceQty ?? 0) > 0 ? "+" : ""}{qty(l.varianceQty ?? 0)}</td>
                  <td className={`num mono ${(l.varianceValue ?? 0) < 0 ? "var-up" : "var-down"}`}>{inr(l.varianceValue ?? 0)}</td>
                  <td className="num mono faint">{qty(l.movedSinceFreeze)}</td>
                </tr>
              ))}
              {variances.length === 0 && <tr><td colSpan={6} className="empty">No variances {counted ? "— counts match the books." : "yet."}</td></tr>}
            </tbody>
          </table>
          {editable && counted < sc.lines.length && (
            <p className="hint">{sc.lines.length - counted} material(s) not counted — they will be left unchanged when posting.</p>
          )}
          {sc.status === "POSTED" && <p className="hint">Posted {shortDate(sc.postedAt)} as stock adjustments ({inr(sc.varianceValue)}).</p>}
        </>
      )}

      {editable && (
        <div className="proc-actions" style={{ marginTop: 18 }}>
          {sc.status === "COUNTING" && (
            <button className="btn-ghost" onClick={() => void run(() => procApi.submitCount(outletId, id))} disabled={!counted}>
              Submit for review
            </button>
          )}
          <button
            className="btn-primary"
            disabled={!counted}
            onClick={() => (armed === "post" ? void run(() => procApi.postCount(outletId, id)) : setArmed("post"))}
          >
            {armed === "post" ? `Confirm: post ${inr(net)} adjustment` : "Approve & post"}
          </button>
          <button
            className={`btn-ghost ${armed === "cancel" ? "danger" : ""}`}
            onClick={() => (armed === "cancel" ? void run(() => procApi.cancelCount(outletId, id)) : setArmed("cancel"))}
          >
            {armed === "cancel" ? "Confirm cancel" : "Cancel count"}
          </button>
        </div>
      )}
    </div>
  );
}
