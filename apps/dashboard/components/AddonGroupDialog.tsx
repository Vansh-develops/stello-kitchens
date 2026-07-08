"use client";

import { useState } from "react";
import type { AddonGroupAdminDto, AddonGroupInput } from "@stello/shared";
import { api } from "@/lib/api";

export function AddonGroupDialog({
  outletId,
  group,
  onClose,
  onSaved,
}: {
  outletId: string;
  group: AddonGroupAdminDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [minSelect, setMinSelect] = useState(String(group?.minSelect ?? 0));
  const [maxSelect, setMaxSelect] = useState(String(group?.maxSelect ?? 1));
  const [addons, setAddons] = useState<{ name: string; price: string }[]>(
    group?.addons.map((a) => ({ name: a.name, price: String(a.price) })) ?? [{ name: "", price: "" }],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setAddon = (i: number, field: "name" | "price", value: string) =>
    setAddons((prev) => prev.map((a, idx) => (idx === i ? { ...a, [field]: value } : a)));

  const submit = async () => {
    setError(null);
    const cleaned = addons.filter((a) => a.name.trim());
    if (!name.trim()) return setError("Group name is required.");
    if (cleaned.length === 0) return setError("Add at least one option.");

    const payload: AddonGroupInput = {
      name: name.trim(),
      minSelect: Number(minSelect) || 0,
      maxSelect: Number(maxSelect) || 1,
      addons: cleaned.map((a) => ({ name: a.name.trim(), price: Number(a.price) || 0 })),
    };
    setBusy(true);
    try {
      if (group) await api.updateAddonGroup(outletId, group.id, payload);
      else await api.createAddonGroup(outletId, payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{group ? "Edit add-on group" : "New add-on group"}</h2>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            Group name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Extra Toppings" />
          </label>
          <div className="field-row">
            <label className="field short">
              Min select
              <input type="number" value={minSelect} onChange={(e) => setMinSelect(e.target.value)} />
            </label>
            <label className="field short">
              Max select
              <input type="number" value={maxSelect} onChange={(e) => setMaxSelect(e.target.value)} />
            </label>
          </div>
          <section className="editor-section">
            <div className="section-head">
              <h3>Options</h3>
              <button
                className="add-row"
                type="button"
                onClick={() => setAddons((p) => [...p, { name: "", price: "" }])}
              >
                + Add option
              </button>
            </div>
            {addons.map((a, i) => (
              <div key={i} className="var-row">
                <input
                  placeholder="Extra Cheese"
                  value={a.name}
                  onChange={(e) => setAddon(i, "name", e.target.value)}
                />
                <input
                  type="number"
                  placeholder="Price"
                  value={a.price}
                  onChange={(e) => setAddon(i, "price", e.target.value)}
                />
                <button
                  className="del-row"
                  type="button"
                  onClick={() => setAddons((p) => p.filter((_, idx) => idx !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </section>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : group ? "Save changes" : "Create group"}
          </button>
        </footer>
      </div>
    </div>
  );
}
