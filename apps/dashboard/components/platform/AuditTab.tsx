"use client";

import { useCallback, useEffect, useState } from "react";
import { hasPermission, type AuditFacetsDto, type AuditLogDto, type AuthUser } from "@stello/shared";
import { platformApi } from "@/lib/platform-api";
import "./platform.css";

type Filters = { actorId: string; action: string; entity: string; entityId: string; from: string; to: string };
const EMPTY: Filters = { actorId: "", action: "", entity: "", entityId: "", from: "", to: "" };
const PAGE = 50;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pretty = (action: string) => action.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Tenant audit trail: filter by actor/action/entity/date, keyset "load more", entry detail. */
export function AuditTab({ user }: { user: AuthUser }) {
  const [facets, setFacets] = useState<AuditFacetsDto | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<AuditLogDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditLogDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const allowed = hasPermission(user.permissions, "audit.view");

  const fetchPage = useCallback(async (f: Filters, after: string | null) => {
    setLoading(true);
    try {
      const page = await platformApi.auditPage({ ...f, cursor: after ?? undefined, limit: PAGE });
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void platformApi.auditFacets().then(setFacets).catch(() => undefined);
  }, [allowed]);

  useEffect(() => {
    if (!allowed) return;
    setSelected(null);
    void fetchPage(filters, null);
  }, [allowed, filters, fetchPage]);

  if (!allowed) return <div className="pf-access">You need the “View audit log” permission to see this page.</div>;

  const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const actorName = (e: AuditLogDto) => (e.actor ? e.actor.name : e.action.startsWith("API_KEY") ? "API key" : "System");

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Audit log</h1>
        <button className="btn-ghost sm" onClick={() => void fetchPage(filters, null)} disabled={loading}>Refresh</button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="pf-filters">
        <label className="pf-label">Who
          <select value={filters.actorId} onChange={(e) => set("actorId", e.target.value)}>
            <option value="">Anyone</option>
            {facets?.actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="pf-label">Action
          <select value={filters.action} onChange={(e) => set("action", e.target.value)}>
            <option value="">Any action</option>
            {facets?.actions.map((a) => <option key={a} value={a}>{pretty(a)}</option>)}
          </select>
        </label>
        <label className="pf-label">Entity
          <select value={filters.entity} onChange={(e) => set("entity", e.target.value)}>
            <option value="">Any</option>
            {facets?.entities.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="pf-label">Entity id<input value={filters.entityId} onChange={(e) => set("entityId", e.target.value.trim())} placeholder="exact id" /></label>
        <label className="pf-label">From<input type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} /></label>
        <label className="pf-label">To<input type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} /></label>
        {JSON.stringify(filters) !== JSON.stringify(EMPTY) && <button className="text-btn" onClick={() => setFilters(EMPTY)}>Clear filters</button>}
      </div>

      <div className="pf-grid wide-left">
        <div className="pf-stack">
          <div className="pf-scroll">
            <table className="pf-table">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th></tr></thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => setSelected(e)} style={selected?.id === e.id ? { background: "var(--accent-soft)" } : undefined}>
                    <td className="pf-mono">{when(e.createdAt)}</td>
                    <td>{actorName(e)}</td>
                    <td>{pretty(e.action)}</td>
                    <td className="pf-faint">{e.entity}{e.entityId ? ` · ${e.entityId.slice(0, 10)}` : ""}</td>
                  </tr>
                ))}
                {!loading && items.length === 0 && <tr><td colSpan={4} className="empty">No entries match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="pf-row">
            {cursor && <button className="btn-ghost sm" disabled={loading} onClick={() => void fetchPage(filters, cursor)}>{loading ? "Loading…" : "Load more"}</button>}
            <span className="pf-faint">{items.length} shown{cursor ? "" : " · end of log"}</span>
          </div>
        </div>

        <div className="report-card">
          <span className="card-title">Entry detail</span>
          {!selected && <p className="hint">Select an entry to see everything that was recorded.</p>}
          {selected && (
            <div className="pf-stack">
              <dl className="pf-kv">
                <dt>When</dt><dd>{when(selected.createdAt)}</dd>
                <dt>Action</dt><dd className="pf-mono">{selected.action}</dd>
                <dt>Who</dt><dd>{selected.actor ? `${selected.actor.name} (${selected.actor.email})` : actorName(selected)}</dd>
                <dt>Entity</dt><dd>{selected.entity}</dd>
                <dt>Entity id</dt>
                <dd className="pf-mono">
                  {selected.entityId ?? "—"}
                  {selected.entityId && <> · <button className="text-btn" onClick={() => setFilters({ ...EMPTY, entity: selected.entity, entityId: selected.entityId! })}>history</button></>}
                </dd>
                <dt>Entry id</dt><dd className="pf-mono">{selected.id}</dd>
              </dl>
              <pre className="pf-json">{selected.data == null ? "No extra data recorded." : JSON.stringify(selected.data, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
