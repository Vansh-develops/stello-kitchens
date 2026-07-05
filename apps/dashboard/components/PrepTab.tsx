"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PrepRecipeDto, RawMaterialDto } from "@petpooja/shared";
import { api } from "@/lib/api";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

type DraftLine = { inputMaterialId: string; quantity: string };

export function PrepTab({ outletId }: { outletId: string }) {
  const [materials, setMaterials] = useState<RawMaterialDto[]>([]);
  const [recipes, setRecipes] = useState<Record<string, PrepRecipeDto>>({});
  const [editing, setEditing] = useState<{ materialId: string; lines: DraftLine[] } | null>(null);
  const [produceQty, setProduceQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const mats = await api.materials(outletId);
      setMaterials(mats);
      const semi = mats.filter((m) => m.isSemiFinished);
      const loaded = await Promise.all(semi.map((m) => api.prepRecipe(outletId, m.id)));
      setRecipes(Object.fromEntries(loaded.map((r) => [r.materialId, r])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const semiFinished = useMemo(() => materials.filter((m) => m.isSemiFinished), [materials]);
  const materialName = (id: string) => materials.find((m) => m.id === id)?.name ?? "—";
  const materialUnit = (id: string) => materials.find((m) => m.id === id)?.unit ?? "";

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      await reload();
      if (ok) {
        setMessage(ok);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const openEditor = (materialId: string) => {
    const existing = recipes[materialId];
    setEditing({
      materialId,
      lines: existing?.ingredients.length
        ? existing.ingredients.map((i) => ({ inputMaterialId: i.inputMaterialId, quantity: String(i.quantity) }))
        : [{ inputMaterialId: "", quantity: "" }],
    });
    setMessage(null);
  };

  const saveRecipe = () =>
    run(async () => {
      if (!editing) return;
      const ingredients = editing.lines
        .filter((l) => l.inputMaterialId && Number(l.quantity) > 0)
        .map((l) => ({ inputMaterialId: l.inputMaterialId, quantity: Number(l.quantity) }));
      await api.setPrepRecipe(outletId, editing.materialId, { ingredients });
      setEditing(null);
    }, "Prep recipe saved");

  const produce = (materialId: string) =>
    run(async () => {
      const qty = Number(produceQty[materialId]);
      if (!(qty > 0)) throw new Error("Enter a batch quantity");
      const res = await api.produceBatch(outletId, materialId, qty);
      setProduceQty((p) => ({ ...p, [materialId]: "" }));
      setMessage(`Produced ${qty} ${materialUnit(materialId)} · batch cost ${money(res.batchCost)}`);
    });

  // Materials that could become semi-finished (exclude ones already with a recipe).
  const candidates = materials.filter((m) => !m.isSemiFinished);

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Prep &amp; production</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {message && <div className="banner-ok" onClick={() => setMessage(null)}>{message}</div>}
      <p className="hint wide">
        Semi-finished goods (a gravy base, a marinade) are produced in-house from a prep recipe.
        Producing a batch consumes the inputs and yields the base at a blended cost; dishes then
        consume the base like any other material.
      </p>

      {editing && (
        <div className="report-card prep-builder">
          <span className="card-title">Prep recipe for {materialName(editing.materialId)} — inputs per 1 {materialUnit(editing.materialId)}</span>
          {editing.lines.map((line, i) => (
            <div key={i} className="prep-line">
              <select
                value={line.inputMaterialId}
                onChange={(e) =>
                  setEditing((p) => p && { ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, inputMaterialId: e.target.value } : l)) })
                }
              >
                <option value="">Select input…</option>
                {materials
                  .filter((m) => m.id !== editing.materialId)
                  .map((m) => (
                    <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>
                  ))}
              </select>
              <input
                type="number"
                step="0.001"
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) =>
                  setEditing((p) => p && { ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)) })
                }
              />
              <button
                className="del-row"
                onClick={() => setEditing((p) => p && { ...p, lines: p.lines.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="cb-actions">
            <button
              className="add-row"
              onClick={() => setEditing((p) => p && { ...p, lines: [...p.lines, { inputMaterialId: "", quantity: "" }] })}
            >
              + Add input
            </button>
            <div className="cb-actions-right">
              <button className="btn-ghost sm" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary sm" onClick={saveRecipe}>Save recipe</button>
            </div>
          </div>
        </div>
      )}

      <div className="prep-list">
        {semiFinished.map((m) => {
          const recipe = recipes[m.id];
          return (
            <div key={m.id} className="prep-card">
              <div className="prep-head">
                <div>
                  <span className="semi-badge">SEMI</span>
                  <span className="prep-name">{m.name}</span>
                </div>
                <span className="prep-stock">
                  {m.stockQty} {m.unit} in stock
                </span>
              </div>
              <div className="prep-recipe">
                {recipe?.ingredients.map((ing) => (
                  <div key={ing.inputMaterialId} className="prep-ing">
                    <span>{ing.materialName}</span>
                    <span className="mono">
                      {ing.quantity} {ing.unit}
                      {ing.stockQty < ing.quantity && <em className="short"> low</em>}
                    </span>
                  </div>
                ))}
                <div className="prep-costline">
                  <span>Cost to make 1 {m.unit}</span>
                  <span className="mono">{money(recipe?.unitCost ?? 0)}</span>
                </div>
              </div>
              <div className="prep-foot">
                <div className="produce-row">
                  <input
                    type="number"
                    step="0.1"
                    placeholder={`Batch (${m.unit})`}
                    value={produceQty[m.id] ?? ""}
                    onChange={(e) => setProduceQty((p) => ({ ...p, [m.id]: e.target.value }))}
                  />
                  <button className="btn-primary sm" onClick={() => produce(m.id)}>Produce</button>
                </div>
                <button className="text-btn" onClick={() => openEditor(m.id)}>Edit recipe</button>
              </div>
            </div>
          );
        })}
        {semiFinished.length === 0 && !editing && (
          <p className="empty">No semi-finished goods yet. Turn a material into one below.</p>
        )}
      </div>

      {!editing && candidates.length > 0 && (
        <div className="prep-new">
          <span className="opt-label">Make a material semi-finished</span>
          <div className="prep-new-row">
            <select id="prep-new-select" defaultValue="">
              <option value="" disabled>Choose a material…</option>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>
              ))}
            </select>
            <button
              className="btn-ghost sm"
              onClick={() => {
                const sel = document.getElementById("prep-new-select") as HTMLSelectElement | null;
                if (sel?.value) openEditor(sel.value);
              }}
            >
              Define prep recipe
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
