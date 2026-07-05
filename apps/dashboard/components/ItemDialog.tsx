"use client";

import { useMemo, useState } from "react";
import type {
  AddonGroupAdminDto,
  AdminCategoryDto,
  AdminItemDto,
  ChannelDto,
  CreateItemInput,
} from "@petpooja/shared";
import { api } from "@/lib/api";

type ChannelForm = { price: string; externalId: string };

export function ItemDialog({
  outletId,
  item,
  defaultCategoryId,
  categories,
  addonGroups,
  channels,
  onClose,
  onSaved,
}: {
  outletId: string;
  item: AdminItemDto | null;
  defaultCategoryId: string;
  categories: AdminCategoryDto[];
  addonGroups: AddonGroupAdminDto[];
  channels: ChannelDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? defaultCategoryId);
  const [shortCode, setShortCode] = useState(item?.shortCode ?? "");
  const [price, setPrice] = useState(item ? String(item.price) : "");
  const [isVeg, setIsVeg] = useState(item?.isVeg ?? true);
  const [taxRate, setTaxRate] = useState(item ? String(item.taxRate) : "5");
  const [availableStart, setAvailableStart] = useState(item?.availableStart ?? "");
  const [availableEnd, setAvailableEnd] = useState(item?.availableEnd ?? "");
  const [variations, setVariations] = useState<{ name: string; price: string }[]>(
    item?.variations.map((v) => ({ name: v.name, price: String(v.price) })) ?? [],
  );
  const [addonGroupIds, setAddonGroupIds] = useState<Set<string>>(
    new Set(item?.addonGroupIds ?? []),
  );
  const [channelForm, setChannelForm] = useState<Record<string, ChannelForm>>(() => {
    const map: Record<string, ChannelForm> = {};
    for (const ch of channels) {
      const cfg = item?.channels.find((c) => c.channelId === ch.id);
      map[ch.id] = {
        price: cfg?.price != null ? String(cfg.price) : "",
        externalId: cfg?.externalId ?? "",
      };
    }
    return map;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const aggregatorChannels = useMemo(
    () => channels.filter((c) => c.kind === "AGGREGATOR"),
    [channels],
  );

  const setVariation = (i: number, field: "name" | "price", value: string) =>
    setVariations((prev) => prev.map((v, idx) => (idx === i ? { ...v, [field]: value } : v)));

  const toggleAddon = (id: string) =>
    setAddonGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setChannel = (channelId: string, field: keyof ChannelForm, value: string) =>
    setChannelForm((prev) => ({ ...prev, [channelId]: { ...prev[channelId], [field]: value } }));

  const submit = async () => {
    setError(null);
    const priceNum = Number(price);
    if (!name.trim()) return setError("Name is required.");
    if (!priceNum || priceNum < 0) return setError("Enter a valid base price.");
    if ((availableStart && !availableEnd) || (!availableStart && availableEnd))
      return setError("Set both start and end times, or neither.");

    const payload: CreateItemInput = {
      categoryId,
      name: name.trim(),
      shortCode: shortCode.trim() || null,
      price: priceNum,
      isVeg,
      taxRate: Number(taxRate) || 0,
      availableStart: availableStart || null,
      availableEnd: availableEnd || null,
      variations: variations
        .filter((v) => v.name.trim())
        .map((v) => ({ name: v.name.trim(), price: Number(v.price) || 0 })),
      addonGroupIds: [...addonGroupIds],
      channels: channels.map((ch) => {
        const f = channelForm[ch.id];
        return {
          channelId: ch.id,
          isListed: true,
          price: f.price.trim() === "" ? null : Number(f.price),
          externalId: f.externalId.trim() || null,
        };
      }),
    };

    setBusy(true);
    try {
      if (item) await api.updateItem(outletId, item.id, payload);
      else await api.createItem(outletId, payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{item ? "Edit item" : "New item"}</h2>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="field-row">
            <label className="field grow">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Paneer Tikka" />
            </label>
            <label className="field short">
              Shortcode
              <input value={shortCode} onChange={(e) => setShortCode(e.target.value)} placeholder="PT" />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              Category
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field short">
              Base price
              <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
            </label>
            <label className="field short">
              GST %
              <input type="number" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            </label>
          </div>

          <div className="field-row">
            <div className="field">
              <span>Type</span>
              <div className="veg-toggle">
                <button className={isVeg ? "on veg" : ""} onClick={() => setIsVeg(true)} type="button">
                  Veg
                </button>
                <button className={!isVeg ? "on nonveg" : ""} onClick={() => setIsVeg(false)} type="button">
                  Non-veg
                </button>
              </div>
            </div>
            <label className="field short">
              Available from
              <input type="time" value={availableStart} onChange={(e) => setAvailableStart(e.target.value)} />
            </label>
            <label className="field short">
              until
              <input type="time" value={availableEnd} onChange={(e) => setAvailableEnd(e.target.value)} />
            </label>
          </div>
          <p className="hint">Leave times empty for all-day availability (e.g. set 07:00–11:00 for breakfast-only).</p>

          <section className="editor-section">
            <div className="section-head">
              <h3>Variations</h3>
              <button
                className="add-row"
                type="button"
                onClick={() => setVariations((p) => [...p, { name: "", price: "" }])}
              >
                + Add variation
              </button>
            </div>
            {variations.length === 0 && <p className="hint">No variations — the base price applies.</p>}
            {variations.map((v, i) => (
              <div key={i} className="var-row">
                <input
                  placeholder="Half"
                  value={v.name}
                  onChange={(e) => setVariation(i, "name", e.target.value)}
                />
                <input
                  type="number"
                  placeholder="Price"
                  value={v.price}
                  onChange={(e) => setVariation(i, "price", e.target.value)}
                />
                <button
                  className="del-row"
                  type="button"
                  onClick={() => setVariations((p) => p.filter((_, idx) => idx !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </section>

          <section className="editor-section">
            <h3>Add-on groups</h3>
            {addonGroups.length === 0 && <p className="hint">No add-on groups yet — create them in the Add-ons tab.</p>}
            <div className="chip-select">
              {addonGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`select-chip ${addonGroupIds.has(g.id) ? "on" : ""}`}
                  onClick={() => toggleAddon(g.id)}
                >
                  {g.name}
                  <em>{g.addons.length}</em>
                </button>
              ))}
            </div>
          </section>

          <section className="editor-section">
            <h3>Channel pricing</h3>
            <p className="hint">
              Override the price per channel to absorb aggregator commission. Empty = base price (₹{price || "—"}).
              Aggregator channels also take an external item ID for menu push.
            </p>
            <div className="channel-grid">
              <div className="cg-head">
                <span>Channel</span>
                <span>Price override</span>
                <span>External ID</span>
              </div>
              {channels.map((ch) => (
                <div key={ch.id} className="cg-row">
                  <span className="cg-name">
                    {ch.name}
                    <em>{ch.kind === "AGGREGATOR" ? "aggregator" : "direct"}</em>
                  </span>
                  <input
                    type="number"
                    placeholder={price || "base"}
                    value={channelForm[ch.id]?.price ?? ""}
                    onChange={(e) => setChannel(ch.id, "price", e.target.value)}
                  />
                  <input
                    placeholder={ch.kind === "AGGREGATOR" ? "e.g. ZOM-1234" : "—"}
                    disabled={ch.kind !== "AGGREGATOR"}
                    value={channelForm[ch.id]?.externalId ?? ""}
                    onChange={(e) => setChannel(ch.id, "externalId", e.target.value)}
                  />
                </div>
              ))}
            </div>
            {aggregatorChannels.length === 0 && (
              <p className="hint">Add an aggregator channel in the Channels tab to configure external IDs.</p>
            )}
          </section>

          {error && <p className="form-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary grow" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : item ? "Save changes" : "Create item"}
          </button>
        </footer>
      </div>
    </div>
  );
}
