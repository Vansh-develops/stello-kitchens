"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConsumptionRowDto, RawMaterialDto, VendorDto, MaterialUnit } from "@petpooja/shared";
import { api } from "@/lib/api";

const UNITS: MaterialUnit[] = ["KG", "G", "L", "ML", "PCS"];
const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function InventoryTab({ outletId }: { outletId: string }) {
  const [materials, setMaterials] = useState<RawMaterialDto[]>([]);
  const [vendors, setVendors] = useState<VendorDto[]>([]);
  const [consumption, setConsumption] = useState<ConsumptionRowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [materialModal, setMaterialModal] = useState<{ material: RawMaterialDto | null } | null>(null);
  const [receiveModal, setReceiveModal] = useState<RawMaterialDto | null>(null);
  const [wastageModal, setWastageModal] = useState<RawMaterialDto | null>(null);
  const [newVendor, setNewVendor] = useState({ name: "", phone: "" });

  const reload = useCallback(async () => {
    try {
      const [m, v, c] = await Promise.all([
        api.materials(outletId),
        api.vendors(outletId),
        api.consumption(outletId, 7),
      ]);
      setMaterials(m);
      setVendors(v);
      setConsumption(c);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inventory");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setConfirmDelete(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const lowStock = useMemo(() => materials.filter((m) => m.lowStock), [materials]);
  const stockValue = useMemo(
    () => materials.reduce((s, m) => s + m.stockQty * m.costPerUnit, 0),
    [materials],
  );

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Inventory</h1>
        <button className="btn-primary sm" onClick={() => setMaterialModal({ material: null })}>
          + Add material
        </button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="inv-stats">
        <div className="stat">
          <span className="stat-label">Materials</span>
          <span className="stat-value">{materials.length}</span>
        </div>
        <div className={`stat ${lowStock.length ? "warn" : ""}`}>
          <span className="stat-label">Low stock</span>
          <span className="stat-value">{lowStock.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Stock value</span>
          <span className="stat-value">{money(Math.round(stockValue))}</span>
        </div>
      </div>

      {lowStock.length > 0 && (
        <div className="lowstock-banner">
          <strong>Reorder needed:</strong> {lowStock.map((m) => `${m.name} (${m.stockQty} ${m.unit})`).join(", ")}
        </div>
      )}

      <div className="inv-grid">
        <div className="inv-materials">
          <table className="data-table">
            <thead>
              <tr>
                <th>Material</th>
                <th className="num">On hand</th>
                <th className="num">Reorder</th>
                <th className="num">Cost/unit</th>
                <th className="num">Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id} className={m.lowStock ? "low" : ""}>
                  <td className="strong">{m.name}</td>
                  <td className="num mono">
                    {m.stockQty} <span className="unit">{m.unit}</span>
                  </td>
                  <td className="num mono faint">{m.reorderLevel}</td>
                  <td className="num mono">{money(m.costPerUnit)}</td>
                  <td className="num mono">{money(Math.round(m.stockQty * m.costPerUnit))}</td>
                  <td className="row-actions">
                    <button className="text-btn" onClick={() => setReceiveModal(m)}>Receive</button>
                    <button className="text-btn" onClick={() => setWastageModal(m)}>Waste</button>
                    <button className="text-btn" onClick={() => setMaterialModal({ material: m })}>Edit</button>
                    <button
                      className={`text-btn danger ${confirmDelete === m.id ? "armed" : ""}`}
                      onClick={() =>
                        confirmDelete === m.id
                          ? void run(() => api.deleteMaterial(outletId, m.id))
                          : setConfirmDelete(m.id)
                      }
                    >
                      {confirmDelete === m.id ? "Confirm" : "Del"}
                    </button>
                  </td>
                </tr>
              ))}
              {materials.length === 0 && (
                <tr><td colSpan={6} className="empty">No materials yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <aside className="inv-side">
          <section className="side-card">
            <h3>Consumption · 7 days</h3>
            {consumption.length === 0 && <p className="hint">No consumption yet. Punch an order to deplete stock.</p>}
            <ul className="consume-list">
              {consumption.slice(0, 8).map((c) => (
                <li key={c.rawMaterialId}>
                  <span>{c.name}</span>
                  <span className="mono">{c.consumedQty} {c.unit}</span>
                  <span className="mono faint">{money(c.consumedCost)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="side-card">
            <h3>Vendors</h3>
            <ul className="vendor-list">
              {vendors.map((v) => (
                <li key={v.id}>
                  <span>{v.name}</span>
                  {v.phone && <span className="faint">{v.phone}</span>}
                  <button
                    className={`text-btn danger ${confirmDelete === v.id ? "armed" : ""}`}
                    onClick={() =>
                      confirmDelete === v.id
                        ? void run(() => api.deleteVendor(outletId, v.id))
                        : setConfirmDelete(v.id)
                    }
                  >
                    {confirmDelete === v.id ? "Confirm" : "×"}
                  </button>
                </li>
              ))}
              {vendors.length === 0 && <li className="hint">No vendors yet.</li>}
            </ul>
            <div className="add-vendor">
              <input
                placeholder="Vendor name"
                value={newVendor.name}
                onChange={(e) => setNewVendor((p) => ({ ...p, name: e.target.value }))}
              />
              <input
                placeholder="Phone"
                value={newVendor.phone}
                onChange={(e) => setNewVendor((p) => ({ ...p, phone: e.target.value }))}
              />
              <button
                className="btn-primary sm"
                disabled={!newVendor.name.trim()}
                onClick={() => {
                  void run(() => api.createVendor(outletId, { name: newVendor.name.trim(), phone: newVendor.phone.trim() || null }));
                  setNewVendor({ name: "", phone: "" });
                }}
              >
                Add
              </button>
            </div>
          </section>
        </aside>
      </div>

      {materialModal && (
        <MaterialModal
          outletId={outletId}
          material={materialModal.material}
          onClose={() => setMaterialModal(null)}
          onSaved={() => {
            setMaterialModal(null);
            void reload();
          }}
        />
      )}
      {receiveModal && (
        <ReceiveModal
          outletId={outletId}
          material={receiveModal}
          vendors={vendors}
          onClose={() => setReceiveModal(null)}
          onSaved={() => {
            setReceiveModal(null);
            void reload();
          }}
        />
      )}
      {wastageModal && (
        <WastageModal
          outletId={outletId}
          material={wastageModal}
          onClose={() => setWastageModal(null)}
          onSaved={() => {
            setWastageModal(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function MaterialModal({
  outletId,
  material,
  onClose,
  onSaved,
}: {
  outletId: string;
  material: RawMaterialDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(material?.name ?? "");
  const [unit, setUnit] = useState<MaterialUnit>(material?.unit ?? "KG");
  const [reorder, setReorder] = useState(String(material?.reorderLevel ?? 0));
  const [stock, setStock] = useState(material ? "" : "0");
  const [cost, setCost] = useState(material ? "" : "0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return setError("Name is required.");
    setBusy(true);
    setError(null);
    try {
      if (material) {
        await api.updateMaterial(outletId, material.id, { name: name.trim(), unit, reorderLevel: Number(reorder) || 0 });
      } else {
        await api.createMaterial(outletId, {
          name: name.trim(),
          unit,
          stockQty: Number(stock) || 0,
          reorderLevel: Number(reorder) || 0,
          costPerUnit: Number(cost) || 0,
        });
      }
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
          <h2>{material ? "Edit material" : "New material"}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Chicken" />
          </label>
          <div className="field-row">
            <label className="field">
              Unit
              <select value={unit} onChange={(e) => setUnit(e.target.value as MaterialUnit)}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
            <label className="field short">
              Reorder at
              <input type="number" value={reorder} onChange={(e) => setReorder(e.target.value)} />
            </label>
          </div>
          {!material && (
            <div className="field-row">
              <label className="field short">
                Opening stock
                <input type="number" value={stock} onChange={(e) => setStock(e.target.value)} />
              </label>
              <label className="field short">
                Cost / unit
                <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
              </label>
            </div>
          )}
          {material && <p className="hint">Stock changes go through Receive / Waste, not a direct edit.</p>}
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : material ? "Save" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ReceiveModal({
  outletId,
  material,
  vendors,
  onClose,
  onSaved,
}: {
  outletId: string;
  material: RawMaterialDto;
  vendors: VendorDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState(String(material.costPerUnit));
  const [vendorId, setVendorId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const q = Number(qty);
    if (!q || q <= 0) return setError("Enter a quantity.");
    setBusy(true);
    setError(null);
    try {
      await api.receiveStock(outletId, material.id, {
        quantity: q,
        unitCost: Number(cost) || 0,
        vendorId: vendorId || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not receive");
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Receive · {material.name}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <p className="hint">On hand: {material.stockQty} {material.unit} @ {money(material.costPerUnit)}/unit. New stock blends at a weighted-average cost.</p>
          <div className="field-row">
            <label className="field short">
              Quantity ({material.unit})
              <input type="number" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <label className="field short">
              Cost / unit
              <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
            </label>
          </div>
          <label className="field">
            Vendor (optional)
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">—</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>
            {busy ? "Receiving…" : "Receive stock"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function WastageModal({
  outletId,
  material,
  onClose,
  onSaved,
}: {
  outletId: string;
  material: RawMaterialDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const q = Number(qty);
    if (!q || q <= 0) return setError("Enter a quantity.");
    setBusy(true);
    setError(null);
    try {
      await api.recordWastage(outletId, material.id, { quantity: q, reason: reason.trim() || undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record");
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Record wastage · {material.name}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <label className="field short">
            Quantity ({material.unit})
            <input type="number" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="field">
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="spillage, spoilage…" />
          </label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>
            {busy ? "Recording…" : "Record wastage"}
          </button>
        </footer>
      </div>
    </div>
  );
}
