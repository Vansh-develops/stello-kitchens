"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminMenuDto, ComboDto } from "@stello/shared";
import { api } from "@/lib/api";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

type DraftOption = { itemId: string; priceDelta: string; isDefault: boolean };
type DraftSlot = { name: string; options: DraftOption[] };

const blankSlot = (itemId: string): DraftSlot => ({
  name: "",
  options: [{ itemId, priceDelta: "0", isDefault: true }],
});

export function CombosTab({ outletId }: { outletId: string }) {
  const [menu, setMenu] = useState<AdminMenuDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // New-combo draft
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [price, setPrice] = useState("");
  const [isVeg, setIsVeg] = useState(true);
  const [slots, setSlots] = useState<DraftSlot[]>([]);

  const items = useMemo(() => (menu?.categories ?? []).flatMap((c) => c.items), [menu]);
  const itemName = (id: string) => items.find((i) => i.id === id)?.name ?? "—";

  const reload = useCallback(async () => {
    try {
      const data = await api.adminMenu(outletId);
      setMenu(data);
      setCategoryId((c) => c || data.categories[0]?.id || "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const startDraft = () => {
    setCreating(true);
    setName("");
    setPrice("");
    setIsVeg(true);
    setSlots([blankSlot(items[0]?.id ?? "")]);
  };

  const setSlot = (i: number, patch: Partial<DraftSlot>) =>
    setSlots((p) => p.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const setOption = (si: number, oi: number, patch: Partial<DraftOption>) =>
    setSlots((p) =>
      p.map((s, i) =>
        i === si ? { ...s, options: s.options.map((o, j) => (j === oi ? { ...o, ...patch } : o)) } : s,
      ),
    );
  const setDefault = (si: number, oi: number) =>
    setSlots((p) =>
      p.map((s, i) =>
        i === si ? { ...s, options: s.options.map((o, j) => ({ ...o, isDefault: j === oi })) } : s,
      ),
    );

  const save = () =>
    run(async () => {
      const payload = {
        categoryId,
        name: name.trim(),
        price: Number(price),
        isVeg,
        taxRate: 5,
        slots: slots.map((s) => ({
          name: s.name.trim(),
          options: s.options.map((o) => ({
            itemId: o.itemId,
            priceDelta: Number(o.priceDelta) || 0,
            isDefault: o.isDefault,
          })),
        })),
      };
      if (!payload.name) throw new Error("Give the combo a name");
      if (!(payload.price >= 0)) throw new Error("Enter a valid price");
      if (payload.slots.some((s) => !s.name)) throw new Error("Every slot needs a name");
      await api.comboCreate(outletId, payload);
      setCreating(false);
    });

  if (!menu) return <div className="tab-pane"><p className="empty">{error ?? "Loading…"}</p></div>;

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Combos</h1>
        {!creating && (
          <button className="btn-primary sm" onClick={startDraft} disabled={items.length === 0}>
            + New combo
          </button>
        )}
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <p className="hint wide">
        A combo bundles items at a fixed price with &ldquo;choose one&rdquo; slots. When ordered it
        explodes into its components for the kitchen (each deducting its recipe) while the bill shows
        one combo line.
      </p>

      {creating && (
        <div className="report-card combo-builder">
          <div className="cb-meta">
            <input placeholder="Combo name" value={name} onChange={(e) => setName(e.target.value)} />
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {menu.categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <input type="number" placeholder="Price ₹" value={price} onChange={(e) => setPrice(e.target.value)} />
            <label className="veg-toggle">
              <input type="checkbox" checked={isVeg} onChange={(e) => setIsVeg(e.target.checked)} /> Veg
            </label>
          </div>

          {slots.map((slot, si) => (
            <div key={si} className="cb-slot">
              <div className="cb-slot-head">
                <input
                  className="cb-slot-name"
                  placeholder={`Slot ${si + 1} name (e.g. Main, Drink)`}
                  value={slot.name}
                  onChange={(e) => setSlot(si, { name: e.target.value })}
                />
                <button className="del-row" onClick={() => setSlots((p) => p.filter((_, i) => i !== si))}>✕</button>
              </div>
              {slot.options.map((o, oi) => (
                <div key={oi} className="cb-option">
                  <input
                    type="radio"
                    name={`def-${si}`}
                    checked={o.isDefault}
                    title="Default choice"
                    onChange={() => setDefault(si, oi)}
                  />
                  <select value={o.itemId} onChange={(e) => setOption(si, oi, { itemId: e.target.value })}>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>{it.name}</option>
                    ))}
                  </select>
                  <input
                    className="cb-delta"
                    type="number"
                    placeholder="+₹"
                    value={o.priceDelta}
                    onChange={(e) => setOption(si, oi, { priceDelta: e.target.value })}
                  />
                  <button
                    className="del-row"
                    onClick={() =>
                      setSlots((p) =>
                        p.map((s, i) =>
                          i === si ? { ...s, options: s.options.filter((_, j) => j !== oi) } : s,
                        ),
                      )
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="add-row"
                onClick={() => setSlot(si, { options: [...slot.options, { itemId: items[0]?.id ?? "", priceDelta: "0", isDefault: false }] })}
              >
                + Add option
              </button>
            </div>
          ))}

          <div className="cb-actions">
            <button className="add-row" onClick={() => setSlots((p) => [...p, blankSlot(items[0]?.id ?? "")])}>
              + Add slot
            </button>
            <div className="cb-actions-right">
              <button className="btn-ghost sm" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn-primary sm" onClick={save}>Save combo</button>
            </div>
          </div>
        </div>
      )}

      <div className="combo-list">
        {menu.combos.map((combo) => (
          <ComboCard
            key={combo.id}
            combo={combo}
            itemName={itemName}
            onToggle={() => run(() => api.comboStock(outletId, combo.id, !combo.inStock))}
            onDelete={() => run(() => api.comboDelete(outletId, combo.id))}
          />
        ))}
        {menu.combos.length === 0 && !creating && (
          <p className="empty">No combos yet. Bundle your best sellers into a meal.</p>
        )}
      </div>
    </div>
  );
}

function ComboCard({
  combo,
  itemName,
  onToggle,
  onDelete,
}: {
  combo: ComboDto;
  itemName: (id: string) => string;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`combo-admin-card ${combo.inStock ? "" : "off"}`}>
      <div className="cac-head">
        <div>
          <span className={`veg-mark ${combo.isVeg ? "veg" : "nonveg"}`} />
          <span className="cac-name">{combo.name}</span>
        </div>
        <span className="cac-price">{money(combo.price)}</span>
      </div>
      <div className="cac-slots">
        {combo.slots.map((s) => (
          <div key={s.id} className="cac-slot">
            <span className="cac-slot-name">{s.name}</span>
            <span className="cac-opts">
              {s.options.map((o) => `${o.name}${o.priceDelta > 0 ? ` +₹${o.priceDelta}` : ""}${o.isDefault ? " ★" : ""}`).join(" · ")}
            </span>
          </div>
        ))}
      </div>
      <div className="cac-foot">
        <button className={`stock-toggle ${combo.inStock ? "in" : "out"}`} onClick={onToggle}>
          {combo.inStock ? "In stock" : "86'd"}
        </button>
        <button className="text-btn danger" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}
