"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MaterialPlanningDto,
  ProcurementSettingsDto,
  ProcurementVendorDto,
  SuggestionsDto,
} from "@stello/shared";
import { errMsg, inr, procApi, qty } from "@/lib/procurement-api";

type RowEdit = { reorderLevel: string; parLevel: string; category: string; preferredVendorId: string; leadTimeDays: string; minOrderQty: string };
type Pick = { include: boolean; quantity: string; rate: string; vendorId: string };

const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

export function ReorderPanel({ outletId, onCreated }: { outletId: string; onCreated: () => void }) {
  const [rows, setRows] = useState<MaterialPlanningDto[]>([]);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [vendors, setVendors] = useState<ProcurementVendorDto[]>([]);
  const [settings, setSettings] = useState<ProcurementSettingsDto | null>(null);
  const [sug, setSug] = useState<SuggestionsDto | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [p, v, s, sg] = await Promise.all([
        procApi.planning(outletId),
        procApi.vendors(outletId),
        procApi.settings(outletId),
        procApi.suggestions(outletId),
      ]);
      setRows(p);
      setVendors(v);
      setSettings(s);
      setSug(sg);
      setEdits({});
      setPicks(
        Object.fromEntries(
          sg.groups.flatMap((g) =>
            g.lines.map((l) => [
              l.rawMaterialId,
              { include: !!g.vendorId, quantity: String(l.suggestedQty), rate: String(l.rate), vendorId: g.vendorId ?? "" },
            ]),
          ),
        ),
      );
      setError(null);
    } catch (e) {
      setError(errMsg(e, "Failed to load reorder planning"));
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const editOf = (r: MaterialPlanningDto): RowEdit =>
    edits[r.rawMaterialId] ?? {
      reorderLevel: String(r.reorderLevel),
      parLevel: r.parLevel == null ? "" : String(r.parLevel),
      category: r.category ?? "",
      preferredVendorId: r.preferredVendorId ?? "",
      leadTimeDays: r.leadTimeDays == null ? "" : String(r.leadTimeDays),
      minOrderQty: r.minOrderQty == null ? "" : String(r.minOrderQty),
    };
  const patch = (r: MaterialPlanningDto, p: Partial<RowEdit>) =>
    setEdits((e) => ({ ...e, [r.rawMaterialId]: { ...editOf(r), ...p } }));

  const savePlanning = async () => {
    const changed = Object.entries(edits);
    if (!changed.length) return;
    setBusy(true);
    try {
      await procApi.savePlanning(outletId, {
        rows: changed.map(([id, e]) => ({
          rawMaterialId: id,
          reorderLevel: Number(e.reorderLevel) || 0,
          parLevel: numOrNull(e.parLevel),
          category: e.category.trim() || null,
          preferredVendorId: e.preferredVendorId || null,
          leadTimeDays: numOrNull(e.leadTimeDays),
          minOrderQty: numOrNull(e.minOrderQty),
        })),
      });
      setNotice(`Saved ${changed.length} material(s).`);
      await reload();
    } catch (e) {
      setError(errMsg(e, "Could not save"));
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (s: ProcurementSettingsDto) => {
    try {
      setSettings(await procApi.saveSettings(outletId, s));
      setNotice("Settings saved.");
      setSug(await procApi.suggestions(outletId));
    } catch (e) {
      setError(errMsg(e, "Could not save settings"));
    }
  };

  const chosen = useMemo(
    () =>
      Object.entries(picks)
        .filter(([, p]) => p.include && p.vendorId && Number(p.quantity) > 0)
        .map(([id, p]) => ({ rawMaterialId: id, vendorId: p.vendorId, quantity: Number(p.quantity), rate: Number(p.rate) || 0 })),
    [picks],
  );

  const createPos = async () => {
    setBusy(true);
    try {
      const res = await procApi.suggestionsToPos(outletId, { lines: chosen });
      setNotice(`Created ${res.map((r) => r.poNumber).join(", ")} as drafts.`);
      onCreated();
    } catch (e) {
      setError(errMsg(e, "Could not create POs"));
    } finally {
      setBusy(false);
    }
  };

  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))] as string[];

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Reorder &amp; suggestions</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {notice && <div className="lowstock-banner" onClick={() => setNotice(null)}>{notice}</div>}

      <section>
        <span className="card-title">Suggested purchase</span>
        <p className="hint wide">
          Quantities cover forecast usage for the supplier lead time plus {settings?.coverDays ?? "…"} day(s), keep the
          reorder level as safety stock, top up to par, and net off stock already on approved POs. Edit anything before raising POs.
        </p>
        {sug && sug.groups.length === 0 && <p className="empty">Nothing to order — stock covers the forecast.</p>}
        {sug?.groups.map((g) => (
          <div key={g.vendorId ?? "none"} className="proc-section" style={{ marginTop: 12 }}>
            <h2>{g.vendorName} <span className="unit faint">· {inr(g.total)}</span></h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th></th><th>Material</th><th className="num">On hand</th><th className="num">On order</th>
                  <th className="num">Use / day</th><th>Why</th><th className="num">Order qty</th><th className="num">Rate ₹</th>
                  {!g.vendorId && <th>Vendor</th>}
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l) => {
                  const p = picks[l.rawMaterialId] ?? { include: false, quantity: "", rate: "", vendorId: "" };
                  const set = (x: Partial<Pick>) => setPicks((s) => ({ ...s, [l.rawMaterialId]: { ...p, ...x } }));
                  return (
                    <tr key={l.rawMaterialId} className={l.onHand <= l.reorderLevel ? "low" : ""}>
                      <td><input type="checkbox" checked={p.include} onChange={(e) => set({ include: e.target.checked })} aria-label={`Order ${l.name}`} style={{ width: "auto" }} /></td>
                      <td className="strong">{l.name}</td>
                      <td className="num mono">{qty(l.onHand)} <span className="unit">{l.unit}</span></td>
                      <td className="num mono faint">{qty(l.onOrder)}</td>
                      <td className="num mono faint">{qty(l.avgDailyUsage)}</td>
                      <td className="faint">{l.reason}</td>
                      <td className="num"><input className="cell" type="number" min="0" step="any" value={p.quantity} onChange={(e) => set({ quantity: e.target.value })} /></td>
                      <td className="num"><input className="cell" type="number" min="0" step="any" value={p.rate} onChange={(e) => set({ rate: e.target.value })} /></td>
                      {!g.vendorId && (
                        <td>
                          <select className="cell" value={p.vendorId} onChange={(e) => set({ vendorId: e.target.value, include: !!e.target.value })}>
                            <option value="">Pick vendor</option>
                            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                          </select>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        {sug && sug.groups.length > 0 && (
          <div className="proc-actions" style={{ marginTop: 12 }}>
            <button className="btn-primary" onClick={() => void createPos()} disabled={busy || !chosen.length}>
              Create {new Set(chosen.map((c) => c.vendorId)).size || ""} draft PO(s)
            </button>
          </div>
        )}
      </section>

      <section className="proc-section">
        <div className="proc-toolbar">
          <h2 className="grow" style={{ margin: 0 }}>Reorder &amp; par levels</h2>
          <button className="btn-primary sm" onClick={() => void savePlanning()} disabled={busy || !Object.keys(edits).length}>
            Save {Object.keys(edits).length || ""} change(s)
          </button>
        </div>
        <datalist id="material-categories">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>
        <table className="data-table">
          <thead>
            <tr>
              <th>Material</th><th className="num">On hand</th><th className="num">Reorder at</th><th className="num">Par</th>
              <th>Category</th><th>Preferred vendor</th><th className="num">Lead days</th><th className="num">Pack size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const e = editOf(r);
              return (
                <tr key={r.rawMaterialId} className={r.belowReorder ? "low" : ""}>
                  <td className="strong">{r.name}</td>
                  <td className="num mono">{qty(r.stockQty)} <span className="unit">{r.unit}</span></td>
                  <td className="num"><input className="cell" type="number" min="0" step="any" value={e.reorderLevel} onChange={(ev) => patch(r, { reorderLevel: ev.target.value })} /></td>
                  <td className="num"><input className="cell" type="number" min="0" step="any" value={e.parLevel} placeholder="—" onChange={(ev) => patch(r, { parLevel: ev.target.value })} /></td>
                  <td><input className="cell" style={{ width: 130, textAlign: "left" }} list="material-categories" value={e.category} placeholder="e.g. Produce" onChange={(ev) => patch(r, { category: ev.target.value })} /></td>
                  <td>
                    <select className="cell" value={e.preferredVendorId} onChange={(ev) => patch(r, { preferredVendorId: ev.target.value })}>
                      <option value="">Last used</option>
                      {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </td>
                  <td className="num"><input className="cell" type="number" min="0" value={e.leadTimeDays} placeholder={String(settings?.leadDays ?? "")} onChange={(ev) => patch(r, { leadTimeDays: ev.target.value })} /></td>
                  <td className="num"><input className="cell" type="number" min="0" step="any" value={e.minOrderQty} placeholder="—" onChange={(ev) => patch(r, { minOrderQty: ev.target.value })} /></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8} className="empty">No materials yet.</td></tr>}
          </tbody>
        </table>
      </section>

      {settings && <SettingsCard settings={settings} onSave={saveSettings} />}
    </div>
  );
}

function SettingsCard({ settings, onSave }: { settings: ProcurementSettingsDto; onSave: (s: ProcurementSettingsDto) => void }) {
  const [s, setS] = useState(() => Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])) as Record<keyof ProcurementSettingsDto, string>);
  const field = (k: keyof ProcurementSettingsDto, label: string) => (
    <label className="field short">
      {label}
      <input type="number" min="0" step="any" value={s[k]} onChange={(e) => setS((p) => ({ ...p, [k]: e.target.value }))} />
    </label>
  );
  return (
    <section className="proc-section side-card">
      <h3>Procurement settings</h3>
      <div className="field-row" style={{ flexWrap: "wrap" }}>
        {field("coverDays", "Cover days")}
        {field("leadDays", "Default lead days")}
        {field("lookbackDays", "Forecast history (days)")}
        {field("overReceiptPct", "Over-receipt tolerance %")}
        {field("priceVarianceAlertPct", "Price alert %")}
      </div>
      <div className="proc-actions" style={{ marginTop: 12 }}>
        <button
          className="btn-primary sm"
          onClick={() =>
            onSave({
              coverDays: Math.round(Number(s.coverDays) || 1),
              leadDays: Math.round(Number(s.leadDays) || 0),
              lookbackDays: Math.round(Number(s.lookbackDays) || 28),
              overReceiptPct: Number(s.overReceiptPct) || 0,
              priceVarianceAlertPct: Number(s.priceVarianceAlertPct) || 0,
            })
          }
        >
          Save settings
        </button>
        <span className="hint" style={{ margin: 0 }}>Changing these needs the purchase-approval permission.</span>
      </div>
    </section>
  );
}
