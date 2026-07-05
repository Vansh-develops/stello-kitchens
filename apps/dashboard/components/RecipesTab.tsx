"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ItemCostDto, RawMaterialDto } from "@petpooja/shared";
import { api } from "@/lib/api";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function marginTone(pct: number | null): string {
  if (pct === null) return "";
  if (pct >= 65) return "good";
  if (pct >= 45) return "ok";
  return "low";
}

export function RecipesTab({ outletId }: { outletId: string }) {
  const [costing, setCosting] = useState<ItemCostDto[]>([]);
  const [materials, setMaterials] = useState<RawMaterialDto[]>([]);
  const [editing, setEditing] = useState<ItemCostDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [c, m] = await Promise.all([api.costing(outletId), api.materials(outletId)]);
      setCosting(c);
      setMaterials(m);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recipes");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Recipes & food cost</h1>
      </div>
      <p className="hint wide">
        Map each dish to its raw materials. Food cost and margin update from current material costs; ordering a dish
        auto-deducts its recipe from stock.
      </p>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th className="num">Price</th>
            <th className="num">Food cost</th>
            <th className="num">Margin</th>
            <th className="num">Ingredients</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {costing.map((c) => (
            <tr key={c.itemId}>
              <td className="strong">{c.name}</td>
              <td className="faint">{c.categoryName}</td>
              <td className="num mono">{money(c.price)}</td>
              <td className="num mono">{c.ingredientCount ? money(c.foodCost) : "—"}</td>
              <td className="num mono">
                {c.marginPct === null || !c.ingredientCount ? (
                  <span className="faint">—</span>
                ) : (
                  <span className={`margin ${marginTone(c.marginPct)}`}>{c.marginPct}%</span>
                )}
              </td>
              <td className="num mono faint">{c.ingredientCount || "—"}</td>
              <td className="row-actions">
                <button className="text-btn" onClick={() => setEditing(c)}>
                  {c.ingredientCount ? "Edit recipe" : "Add recipe"}
                </button>
              </td>
            </tr>
          ))}
          {costing.length === 0 && <tr><td colSpan={7} className="empty">No items.</td></tr>}
        </tbody>
      </table>

      {editing && (
        <RecipeEditor
          outletId={outletId}
          item={editing}
          materials={materials}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function RecipeEditor({
  outletId,
  item,
  materials,
  onClose,
  onSaved,
}: {
  outletId: string;
  item: ItemCostDto;
  materials: RawMaterialDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<{ rawMaterialId: string; quantity: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .recipe(outletId, item.itemId)
      .then((r) => {
        setRows(r.ingredients.map((i) => ({ rawMaterialId: i.rawMaterialId, quantity: String(i.quantity) })));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [outletId, item.itemId]);

  const matById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);

  const foodCost = useMemo(
    () =>
      Math.round(
        rows.reduce((s, r) => {
          const m = matById.get(r.rawMaterialId);
          return s + (m ? m.costPerUnit * (Number(r.quantity) || 0) : 0);
        }, 0) * 100,
      ) / 100,
    [rows, matById],
  );
  const margin = item.price > 0 ? Math.round(((item.price - foodCost) / item.price) * 1000) / 10 : null;

  const setRow = (i: number, field: "rawMaterialId" | "quantity", value: string) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));

  const addRow = () => {
    const used = new Set(rows.map((r) => r.rawMaterialId));
    const next = materials.find((m) => !used.has(m.id));
    setRows((prev) => [...prev, { rawMaterialId: next?.id ?? "", quantity: "" }]);
  };

  const submit = async () => {
    const ingredients = rows
      .filter((r) => r.rawMaterialId && Number(r.quantity) > 0)
      .map((r) => ({ rawMaterialId: r.rawMaterialId, quantity: Number(r.quantity) }));
    // guard against duplicate material rows
    if (new Set(ingredients.map((i) => i.rawMaterialId)).size !== ingredients.length) {
      return setError("Each material can appear only once.");
    }
    setBusy(true);
    setError(null);
    try {
      await api.setRecipe(outletId, item.itemId, { ingredients });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save recipe");
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Recipe · {item.name}</h2>
            <span className="settle-sub">Sells at {money(item.price)}</span>
          </div>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          {!loaded && <p className="hint">Loading…</p>}
          {loaded && (
            <>
              <div className="section-head">
                <h3>Ingredients (per plate)</h3>
                <button className="add-row" type="button" onClick={addRow} disabled={rows.length >= materials.length}>
                  + Add ingredient
                </button>
              </div>
              {rows.length === 0 && <p className="hint">No ingredients yet — this item won’t deduct stock.</p>}
              {rows.map((r, i) => {
                const m = matById.get(r.rawMaterialId);
                const lineCost = m ? m.costPerUnit * (Number(r.quantity) || 0) : 0;
                return (
                  <div key={i} className="recipe-row">
                    <select value={r.rawMaterialId} onChange={(e) => setRow(i, "rawMaterialId", e.target.value)}>
                      {materials.map((mat) => (
                        <option key={mat.id} value={mat.id}>{mat.name}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      placeholder="Qty"
                      value={r.quantity}
                      onChange={(e) => setRow(i, "quantity", e.target.value)}
                    />
                    <span className="recipe-unit">{m?.unit ?? ""}</span>
                    <span className="recipe-cost mono">{money(Math.round(lineCost * 100) / 100)}</span>
                    <button className="del-row" type="button" onClick={() => setRows((p) => p.filter((_, idx) => idx !== i))}>✕</button>
                  </div>
                );
              })}

              <div className="recipe-totals">
                <div><span>Food cost</span><strong className="mono">{money(foodCost)}</strong></div>
                <div>
                  <span>Margin</span>
                  <strong className={`mono margin ${marginTone(margin)}`}>{margin === null ? "—" : `${margin}%`}</strong>
                </div>
              </div>
              {error && <p className="form-error">{error}</p>}
            </>
          )}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy || !loaded}>
            {busy ? "Saving…" : "Save recipe"}
          </button>
        </footer>
      </div>
    </div>
  );
}
