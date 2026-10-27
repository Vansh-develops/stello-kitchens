"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SUPPORTED_LOCALES,
  formatINR,
  type BrandSummaryDto,
  type MasterAddonGroupDto,
  type MasterCategoryDto,
  type MasterItemDto,
  type MasterMenuDto,
  type MasterOverrideDto,
  type OutletPublishPlanDto,
  type PublishPlanDto,
} from "@stello/shared";
import { growthApi } from "@/lib/growth-api";

type View = "master" | "publish" | "overrides";

const STATUS_TEXT: Record<string, string> = {
  NEVER: "Never published",
  IN_SYNC: "In sync",
  PENDING: "Changes pending",
  FAILED: "Publish failed",
};

// Brand master menu for chains/franchises. Brand admins edit the master and
// publish it (with a diff preview); outlet managers override price,
// availability and visibility for their own outlet.
export function ChainMenuTab({ outletId }: { outletId: string }) {
  const [view, setView] = useState<View>("master");
  const [brands, setBrands] = useState<BrandSummaryDto[] | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MasterMenuDto | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    growthApi
      .brands()
      .then((b) => {
        setBrands(b);
        setBrandId((cur) => cur ?? b[0]?.id ?? null);
      })
      .catch((err) => {
        // No chain.manage permission or plan without the module: outlet overrides still work.
        setBlocked(err instanceof Error ? err.message : "Brand menu unavailable");
        setView("overrides");
      });
  }, []);

  const reload = useCallback(async () => {
    if (!brandId) return;
    try {
      setMenu(await growthApi.masterMenu(brandId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load master menu");
    }
  }, [brandId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setMessage(ok);
      await reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      return false;
    }
  };

  const pending = menu?.outlets.filter((o) => o.status !== "IN_SYNC").length ?? 0;

  return (
    <div className="tab-pane chain-pane">
      <div className="pane-head">
        <h1>Brand menu</h1>
        <div className="chain-head-right">
          {brands && brands.length > 1 && (
            <select value={brandId ?? ""} onChange={(e) => setBrandId(e.target.value)}>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
          <div className="seg-toggle" role="tablist">
            {!blocked && (
              <>
                <button className={view === "master" ? "active" : ""} onClick={() => setView("master")}>Master menu</button>
                <button className={view === "publish" ? "active" : ""} onClick={() => setView("publish")}>
                  Publish{pending ? ` · ${pending}` : ""}
                </button>
              </>
            )}
            <button className={view === "overrides" ? "active" : ""} onClick={() => setView("overrides")}>This outlet</button>
          </div>
        </div>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {message && <div className="banner-ok" onClick={() => setMessage(null)}>{message}</div>}
      {blocked && view !== "overrides" && <p className="empty">{blocked}</p>}
      {blocked && (
        <p className="hint wide">
          Brand-level menu editing needs the brand-admin permission and the Chain plan ({blocked}). You can still adjust
          this outlet&apos;s prices and availability for brand items below.
        </p>
      )}

      {!blocked && view === "master" && menu && brandId && (
        <MasterEditor menu={menu} brandId={brandId} outletId={outletId} run={run} />
      )}
      {!blocked && view === "publish" && menu && brandId && (
        <PublishPanel menu={menu} brandId={brandId} run={run} onMessage={setMessage} onError={setError} />
      )}
      {view === "overrides" && <OverridesPanel outletId={outletId} onError={setError} />}
      {!blocked && !menu && view !== "overrides" && <p className="empty">Loading brand menu…</p>}
    </div>
  );
}

// ---------- master editor ----------

function MasterEditor({
  menu,
  brandId,
  outletId,
  run,
}: {
  menu: MasterMenuDto;
  brandId: string;
  outletId: string;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
}) {
  const [catId, setCatId] = useState<string | null>(menu.categories[0]?.id ?? null);
  const [newCat, setNewCat] = useState("");
  const [itemDialog, setItemDialog] = useState<{ item: MasterItemDto | null } | null>(null);
  const [groupDialog, setGroupDialog] = useState<{ group: MasterAddonGroupDto | null } | null>(null);
  const [comboDialog, setComboDialog] = useState(false);
  const category = menu.categories.find((c) => c.id === catId) ?? menu.categories[0] ?? null;
  const combos = menu.combos.filter((c) => c.categoryId === category?.id);

  if (menu.categories.length === 0) {
    return (
      <div className="chain-empty">
        <p className="hint wide">
          The master menu is empty. Start from this outlet&apos;s current menu — its categories, items, variants, add-ons
          and combos are copied into the master and linked, so the outlet stays exactly as it is. Other outlets adopt
          matching items by name on their first publish.
        </p>
        <div className="chain-actions">
          <button className="btn-primary sm" onClick={() => run(() => growthApi.importMaster(brandId, outletId), "Master menu created from this outlet")}>
            Import this outlet&apos;s menu
          </button>
          <span className="faint">or</span>
          <input placeholder="First category" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
          <button
            className="btn-ghost sm"
            disabled={!newCat.trim()}
            onClick={async () => {
              if (await run(() => growthApi.createMasterCategory(brandId, { name: newCat.trim(), sortOrder: 0 }))) setNewCat("");
            }}
          >
            Start from scratch
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="menu-layout chain-layout">
        <aside className="cat-side">
          <div className="side-head">Categories · v{menu.version}</div>
          <div className="cat-list">
            {menu.categories.map((c) => (
              <button key={c.id} className={`cat-item ${category?.id === c.id ? "active" : ""}`} onClick={() => setCatId(c.id)}>
                <span>{c.name}</span>
                <em>{c.items.length}</em>
              </button>
            ))}
          </div>
          <div className="add-cat">
            <input
              placeholder="New category"
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && newCat.trim()) {
                  if (await run(() => growthApi.createMasterCategory(brandId, { name: newCat.trim(), sortOrder: menu.categories.length })))
                    setNewCat("");
                }
              }}
            />
          </div>
        </aside>

        <section className="item-main">
          {category && (
            <>
              <div className="section-head">
                <h3>{category.name}</h3>
                <div className="row-actions">
                  <button className="btn-ghost sm danger" onClick={() => run(() => growthApi.deleteMasterCategory(brandId, category.id), "Category removed from the master")}>
                    Remove category
                  </button>
                  <button className="btn-primary sm" onClick={() => setItemDialog({ item: null })}>+ Item</button>
                </div>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Price</th>
                      <th className="num">GST</th>
                      <th>HSN/SAC</th>
                      <th>Variants · add-ons</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {category.items.map((i) => (
                      <tr key={i.id}>
                        <td className="strong">
                          <span className={`veg-dot ${i.isVeg ? "veg" : "nonveg"}`} /> {i.name}
                          {i.nameTranslations?.hi && <span className="faint"> · {i.nameTranslations.hi}</span>}
                        </td>
                        <td className="num mono">{formatINR(i.price)}</td>
                        <td className="num mono">{i.taxRate}%</td>
                        <td className="mono">{i.hsnCode ?? "—"}</td>
                        <td className="faint">
                          {i.variations.length ? `${i.variations.length} variants` : "—"}
                          {i.addonGroupIds.length ? ` · ${i.addonGroupIds.length} add-on groups` : ""}
                        </td>
                        <td className="row-actions">
                          <button className="btn-ghost sm" onClick={() => setItemDialog({ item: i })}>Edit</button>
                          <button className="btn-ghost sm danger" onClick={() => run(() => growthApi.deleteMasterItem(brandId, i.id))}>Remove</button>
                        </td>
                      </tr>
                    ))}
                    {category.items.length === 0 && (
                      <tr><td colSpan={6} className="faint">No items in this category yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="section-head">
                <h3>Combos</h3>
                <button className="btn-ghost sm" onClick={() => setComboDialog(true)}>+ Combo</button>
              </div>
              {combos.length === 0 ? (
                <p className="empty">No combos in this category.</p>
              ) : (
                <ul className="chain-list">
                  {combos.map((c) => (
                    <li key={c.id}>
                      <strong>{c.name}</strong> · {formatINR(c.price)} · {c.slots.map((s) => s.name).join(" + ")}
                      <button className="btn-ghost sm danger" onClick={() => run(() => growthApi.deleteMasterCombo(brandId, c.id))}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div className="section-head">
            <h3>Add-on groups</h3>
            <button className="btn-ghost sm" onClick={() => setGroupDialog({ group: null })}>+ Add-on group</button>
          </div>
          <ul className="chain-list">
            {menu.addonGroups.map((g) => (
              <li key={g.id}>
                <strong>{g.name}</strong> · pick {g.minSelect}–{g.maxSelect} ·{" "}
                <span className="faint">{g.addons.map((a) => `${a.name} ${formatINR(a.price)}`).join(", ")}</span>
                <span className="row-actions">
                  <button className="btn-ghost sm" onClick={() => setGroupDialog({ group: g })}>Edit</button>
                  <button className="btn-ghost sm danger" onClick={() => run(() => growthApi.deleteMasterAddonGroup(brandId, g.id))}>Remove</button>
                </span>
              </li>
            ))}
            {menu.addonGroups.length === 0 && <li className="faint">No add-on groups.</li>}
          </ul>
        </section>
      </div>

      {itemDialog && category && (
        <MasterItemDialog
          brandId={brandId}
          item={itemDialog.item}
          categories={menu.categories}
          defaultCategoryId={category.id}
          addonGroups={menu.addonGroups}
          onClose={() => setItemDialog(null)}
          onSave={async (fn) => {
            if (await run(fn, "Saved to the master — publish to push it to outlets")) setItemDialog(null);
          }}
        />
      )}
      {groupDialog && (
        <AddonGroupEditor
          group={groupDialog.group}
          onClose={() => setGroupDialog(null)}
          onSave={async (body) => {
            const g = groupDialog.group;
            const ok = await run(() => (g ? growthApi.updateMasterAddonGroup(brandId, g.id, body) : growthApi.createMasterAddonGroup(brandId, body)));
            if (ok) setGroupDialog(null);
          }}
        />
      )}
      {comboDialog && category && (
        <ComboEditor
          categories={menu.categories}
          defaultCategoryId={category.id}
          onClose={() => setComboDialog(false)}
          onSave={async (body) => {
            if (await run(() => growthApi.createMasterCombo(brandId, body))) setComboDialog(false);
          }}
        />
      )}
    </>
  );
}

function MasterItemDialog({
  brandId,
  item,
  categories,
  defaultCategoryId,
  addonGroups,
  onClose,
  onSave,
}: {
  brandId: string;
  item: MasterItemDto | null;
  categories: MasterCategoryDto[];
  defaultCategoryId: string;
  addonGroups: MasterAddonGroupDto[];
  onClose: () => void;
  onSave: (fn: () => Promise<unknown>) => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? defaultCategoryId);
  const [price, setPrice] = useState(item ? String(item.price) : "");
  const [isVeg, setIsVeg] = useState(item?.isVeg ?? true);
  const [taxRate, setTaxRate] = useState(item ? String(item.taxRate) : "5");
  const [hsnCode, setHsnCode] = useState(item?.hsnCode ?? "996331");
  const [shortCode, setShortCode] = useState(item?.shortCode ?? "");
  const [variations, setVariations] = useState(item?.variations.map((v) => ({ name: v.name, price: String(v.price) })) ?? []);
  const [groups, setGroups] = useState(new Set(item?.addonGroupIds ?? []));
  const [translations, setTranslations] = useState<Record<string, string>>(item?.nameTranslations ?? {});
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const p = Number(price);
    if (!name.trim() || !Number.isFinite(p) || p < 0) return setError("Name and a valid price are required");
    const body = {
      categoryId,
      name: name.trim(),
      price: p,
      isVeg,
      taxRate: Number(taxRate),
      hsnCode: hsnCode.trim() || null,
      shortCode: shortCode.trim() || null,
      variations: variations.filter((v) => v.name.trim()).map((v) => ({ name: v.name.trim(), price: Number(v.price) || 0 })),
      addonGroupIds: [...groups],
      nameTranslations: Object.fromEntries(Object.entries(translations).filter(([, v]) => v.trim())),
    };
    onSave(() => (item ? growthApi.updateMasterItem(brandId, item.id, body) : growthApi.createMasterItem(brandId, body)));
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{item ? "Edit master item" : "New master item"}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <div className="field-row">
            <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
            <label className="field short"><span>Short code</span><input value={shortCode} onChange={(e) => setShortCode(e.target.value)} /></label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Category</span>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="field short"><span>Price ₹</span><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          </div>
          <div className="field-row">
            <label className="field short">
              <span>GST %</span>
              <select value={taxRate} onChange={(e) => setTaxRate(e.target.value)}>
                {["0", "5", "12", "18", "28"].map((r) => (
                  <option key={r} value={r}>{r}%</option>
                ))}
              </select>
            </label>
            <label className="field short"><span>HSN / SAC</span><input value={hsnCode} onChange={(e) => setHsnCode(e.target.value)} /></label>
            <label className="chk"><input type="checkbox" checked={isVeg} onChange={(e) => setIsVeg(e.target.checked)} /> Vegetarian</label>
          </div>

          <div>
            <div className="field-label">Variants</div>
            {variations.map((v, idx) => (
              <div key={idx} className="field-row">
                <input placeholder="Half / Full" value={v.name} onChange={(e) => setVariations(variations.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} />
                <input placeholder="₹" inputMode="decimal" value={v.price} onChange={(e) => setVariations(variations.map((x, i) => (i === idx ? { ...x, price: e.target.value } : x)))} />
                <button className="btn-ghost sm" onClick={() => setVariations(variations.filter((_, i) => i !== idx))}>✕</button>
              </div>
            ))}
            <button className="btn-ghost sm" onClick={() => setVariations([...variations, { name: "", price: "" }])}>+ Variant</button>
          </div>

          {addonGroups.length > 0 && (
            <div>
              <div className="field-label">Add-on groups</div>
              <div className="chip-row">
                {addonGroups.map((g) => (
                  <label key={g.id} className="chk">
                    <input
                      type="checkbox"
                      checked={groups.has(g.id)}
                      onChange={(e) => {
                        const next = new Set(groups);
                        if (e.target.checked) next.add(g.id);
                        else next.delete(g.id);
                        setGroups(next);
                      }}
                    />{" "}
                    {g.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="field-label">Name translations (shown to diners)</div>
            <div className="translation-grid">
              {SUPPORTED_LOCALES.filter((l) => l.code !== "en").map((l) => (
                <label key={l.code} className="field">
                  <span>{l.nativeName}</span>
                  <input value={translations[l.code] ?? ""} onChange={(e) => setTranslations({ ...translations, [l.code]: e.target.value })} />
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit}>{item ? "Save" : "Add item"}</button>
        </div>
      </div>
    </div>
  );
}

function AddonGroupEditor({
  group,
  onClose,
  onSave,
}: {
  group: MasterAddonGroupDto | null;
  onClose: () => void;
  onSave: (body: { name: string; minSelect: number; maxSelect: number; addons: { name: string; price: number }[] }) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [minSelect, setMin] = useState(String(group?.minSelect ?? 0));
  const [maxSelect, setMax] = useState(String(group?.maxSelect ?? 1));
  const [addons, setAddons] = useState(group?.addons.map((a) => ({ name: a.name, price: String(a.price) })) ?? [{ name: "", price: "" }]);
  const valid = name.trim() && addons.some((a) => a.name.trim());
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{group ? "Edit add-on group" : "New add-on group"}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="field-row">
            <label className="field short"><span>Min</span><input inputMode="numeric" value={minSelect} onChange={(e) => setMin(e.target.value)} /></label>
            <label className="field short"><span>Max</span><input inputMode="numeric" value={maxSelect} onChange={(e) => setMax(e.target.value)} /></label>
          </div>
          {addons.map((a, idx) => (
            <div key={idx} className="field-row">
              <input placeholder="Add-on" value={a.name} onChange={(e) => setAddons(addons.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} />
              <input placeholder="₹" inputMode="decimal" value={a.price} onChange={(e) => setAddons(addons.map((x, i) => (i === idx ? { ...x, price: e.target.value } : x)))} />
              <button className="btn-ghost sm" onClick={() => setAddons(addons.filter((_, i) => i !== idx))}>✕</button>
            </div>
          ))}
          <button className="btn-ghost sm" onClick={() => setAddons([...addons, { name: "", price: "" }])}>+ Add-on</button>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!valid}
            onClick={() =>
              onSave({
                name: name.trim(),
                minSelect: Math.max(0, Number(minSelect) || 0),
                maxSelect: Math.max(1, Number(maxSelect) || 1),
                addons: addons.filter((a) => a.name.trim()).map((a) => ({ name: a.name.trim(), price: Number(a.price) || 0 })),
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ComboEditor({
  categories,
  defaultCategoryId,
  onClose,
  onSave,
}: {
  categories: MasterCategoryDto[];
  defaultCategoryId: string;
  onClose: () => void;
  onSave: (body: {
    categoryId: string; name: string; price: number; isVeg: boolean; taxRate: number;
    slots: { name: string; options: { masterItemId: string; priceDelta: number; isDefault: boolean }[] }[];
  }) => void;
}) {
  const allItems = useMemo(() => categories.flatMap((c) => c.items), [categories]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState(defaultCategoryId);
  const [slots, setSlots] = useState<{ name: string; itemIds: string[] }[]>([{ name: "Main", itemIds: [] }]);
  const valid = name.trim() && Number(price) > 0 && slots.every((s) => s.name.trim() && s.itemIds.length > 0);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>New master combo</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field short"><span>Price ₹</span><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            <label className="field">
              <span>Category</span>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          </div>
          {slots.map((s, idx) => (
            <div key={idx} className="combo-slot-edit">
              <div className="field-row">
                <input placeholder="Slot (e.g. Drink)" value={s.name} onChange={(e) => setSlots(slots.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} />
                <button className="btn-ghost sm" onClick={() => setSlots(slots.filter((_, i) => i !== idx))}>Remove slot</button>
              </div>
              <div className="chip-row">
                {allItems.map((it) => (
                  <label key={it.id} className="chk">
                    <input
                      type="checkbox"
                      checked={s.itemIds.includes(it.id)}
                      onChange={(e) =>
                        setSlots(
                          slots.map((x, i) =>
                            i === idx
                              ? { ...x, itemIds: e.target.checked ? [...x.itemIds, it.id] : x.itemIds.filter((id) => id !== it.id) }
                              : x,
                          ),
                        )
                      }
                    />{" "}
                    {it.name}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <button className="btn-ghost sm" onClick={() => setSlots([...slots, { name: "", itemIds: [] }])}>+ Slot</button>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!valid}
            onClick={() => {
              const items = slots.flatMap((s) => s.itemIds).map((id) => allItems.find((i) => i.id === id)!);
              onSave({
                categoryId,
                name: name.trim(),
                price: Number(price),
                isVeg: items.every((i) => i.isVeg),
                taxRate: 5,
                slots: slots.map((s) => ({
                  name: s.name.trim(),
                  options: s.itemIds.map((id, i) => ({ masterItemId: id, priceDelta: 0, isDefault: i === 0 })),
                })),
              });
            }}
          >
            Create combo
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- publish ----------

function PublishPanel({
  menu,
  brandId,
  run,
  onMessage,
  onError,
}: {
  menu: MasterMenuDto;
  brandId: string;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  onMessage: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(menu.outlets.filter((o) => o.status !== "IN_SYNC").map((o) => o.outletId)),
  );
  const [plan, setPlan] = useState<PublishPlanDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [newOutlet, setNewOutlet] = useState({ name: "", address: "" });

  const preview = async () => {
    setBusy(true);
    try {
      setPlan(await growthApi.previewPublish(brandId, [...selected]));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      const res = await growthApi.publish(brandId, [...selected]);
      const failed = res.outlets.filter((o) => "error" in o).length;
      onMessage(
        failed
          ? `Published v${res.version} to ${res.outlets.length - failed} outlet(s); ${failed} failed — see status below`
          : `Published v${res.version} to ${res.outlets.length} outlet(s)`,
      );
      setPlan(null);
      await run(async () => undefined);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="hint wide">
        Publishing applies the master (v{menu.version}) to the selected outlets. Outlet price, availability and hidden
        overrides are always kept; local edits to brand-owned fields are reset; items an outlet created itself are
        never touched. Preview first to see exactly what will change.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th />
              <th>Outlet</th>
              <th>Status</th>
              <th className="num">Version</th>
              <th className="num">Overrides</th>
              <th className="num">Outlet-only items</th>
              <th>Last published</th>
            </tr>
          </thead>
          <tbody>
            {menu.outlets.map((o) => (
              <tr key={o.outletId}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(o.outletId)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(o.outletId);
                      else next.delete(o.outletId);
                      setSelected(next);
                      setPlan(null);
                    }}
                  />
                </td>
                <td className="strong">{o.outletName}</td>
                <td>
                  <span className={`sync-badge s-${o.status.toLowerCase()}`} title={o.lastError ?? undefined}>{STATUS_TEXT[o.status]}</span>
                </td>
                <td className="num mono">{o.publishedVersion || "—"}</td>
                <td className="num mono">{o.overrideCount}</td>
                <td className="num mono">{o.outletOnlyItems}</td>
                <td className="faint">{o.lastPublishedAt ? new Date(o.lastPublishedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="chain-actions">
        <button className="btn-ghost sm" disabled={!selected.size || busy} onClick={preview}>Preview changes</button>
        <button className="btn-primary sm" disabled={!selected.size || busy || !plan} onClick={publish}>
          {busy ? "Working…" : `Publish to ${selected.size} outlet${selected.size === 1 ? "" : "s"}`}
        </button>
      </div>

      {plan && plan.outlets.map((o) => <PlanView key={o.outletId} plan={o} />)}

      <div className="section-head">
        <h3>Open a new outlet</h3>
      </div>
      <div className="chain-actions">
        <input placeholder="Outlet name" value={newOutlet.name} onChange={(e) => setNewOutlet({ ...newOutlet, name: e.target.value })} />
        <input placeholder="Address (optional)" value={newOutlet.address} onChange={(e) => setNewOutlet({ ...newOutlet, address: e.target.value })} />
        <button
          className="btn-primary sm"
          disabled={!newOutlet.name.trim()}
          onClick={async () => {
            const ok = await run(
              () => growthApi.createChainOutlet(brandId, { name: newOutlet.name.trim(), address: newOutlet.address.trim() || null, publishMenu: true }),
              `${newOutlet.name.trim()} opened with the brand menu — reload the page to switch to it`,
            );
            if (ok) setNewOutlet({ name: "", address: "" });
          }}
        >
          Create outlet &amp; publish menu
        </button>
      </div>
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  CREATE: "Add", UPDATE: "Update", LINK: "Link", REMOVE: "Remove", DETACH: "Detach", UNCHANGED: "No change",
};

function PlanView({ plan }: { plan: OutletPublishPlanDto }) {
  const [showAll, setShowAll] = useState(false);
  const changed = plan.ops.filter((o) => o.action !== "UNCHANGED");
  const ops = showAll ? plan.ops : changed;
  const fmt = (v: unknown) =>
    v === null || v === undefined ? "—" : typeof v === "object" ? (Array.isArray(v) ? `${v.length} entries` : "…") : String(v);
  return (
    <div className="publish-plan">
      <div className="pp-head">
        <strong>{plan.outletName}</strong>
        <span className="faint">
          {(["CREATE", "UPDATE", "LINK", "REMOVE", "DETACH"] as const)
            .filter((k) => plan.counts[k])
            .map((k) => `${plan.counts[k]} ${ACTION_LABEL[k].toLowerCase()}`)
            .join(" · ") || "Nothing to change"}
          {plan.conflicts ? ` · ${plan.conflicts} rule${plan.conflicts === 1 ? "" : "s"} applied` : ""}
        </span>
        <button className="btn-ghost sm" onClick={() => setShowAll(!showAll)}>{showAll ? "Changes only" : "Show all"}</button>
      </div>
      {ops.length > 0 && (
        <ul className="pp-ops">
          {ops.map((o, i) => (
            <li key={i} className={`op-${o.action.toLowerCase()}`}>
              <span className="op-tag">{ACTION_LABEL[o.action]}</span>
              <span className="op-entity">{o.entity.replace("_", " ").toLowerCase()}</span>
              <span className="op-name">{o.name}</span>
              {o.changes.length > 0 && (
                <span className="op-changes">
                  {o.changes.map((c) => `${c.field}: ${fmt(c.from)} → ${fmt(c.to)}`).join("; ")}
                </span>
              )}
              {o.conflict && <span className="op-conflict" title={o.conflict.rule}>{o.conflict.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- outlet overrides ----------

function OverridesPanel({ outletId, onError }: { outletId: string; onError: (m: string) => void }) {
  const [rows, setRows] = useState<MasterOverrideDto[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");

  const reload = useCallback(async () => {
    try {
      setRows(await growthApi.overrides(outletId));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load overrides");
      setRows([]);
    }
  }, [outletId, onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (r: MasterOverrideDto, patch: Partial<Pick<MasterOverrideDto, "price" | "inStock" | "isHidden">>) => {
    try {
      await growthApi.setOverride(outletId, r.masterItemId, {
        price: patch.price !== undefined ? patch.price : r.price,
        inStock: patch.inStock !== undefined ? patch.inStock : r.inStock,
        isHidden: patch.isHidden !== undefined ? patch.isHidden : r.isHidden,
      });
      setDrafts((d) => {
        const { [r.masterItemId]: _drop, ...rest } = d;
        return rest;
      });
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Save failed");
    }
  };

  if (!rows) return <p className="empty">Loading…</p>;
  if (rows.length === 0) return <p className="empty">This outlet&apos;s brand has no master menu items yet.</p>;
  const visible = rows.filter((r) => `${r.name} ${r.categoryName}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <>
      <p className="hint wide">
        Overrides apply to this outlet only and take effect immediately. Leave the price blank to follow the brand
        price. Items you add in the regular Menu tab stay outlet-only and are never changed by brand publishes.
      </p>
      <div className="platform-filters">
        <input placeholder="Search items" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th className="num">Brand price</th>
              <th>Outlet price</th>
              <th>Availability</th>
              <th>Visible</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const draft = drafts[r.masterItemId] ?? (r.price === null ? "" : String(r.price));
              return (
                <tr key={r.masterItemId} className={r.isHidden ? "low" : ""}>
                  <td className="strong">{r.name}</td>
                  <td className="faint">{r.categoryName}</td>
                  <td className="num mono">{formatINR(r.masterPrice)}</td>
                  <td>
                    <input
                      className="price-input"
                      inputMode="decimal"
                      placeholder={String(r.masterPrice)}
                      value={draft}
                      onChange={(e) => setDrafts({ ...drafts, [r.masterItemId]: e.target.value })}
                      onBlur={() => {
                        const v = draft.trim() === "" ? null : Number(draft);
                        if (v !== r.price && (v === null || (Number.isFinite(v) && v >= 0))) void save(r, { price: v });
                      }}
                    />
                  </td>
                  <td>
                    <select
                      value={r.inStock === null ? "inherit" : r.inStock ? "in" : "out"}
                      onChange={(e) => save(r, { inStock: e.target.value === "inherit" ? null : e.target.value === "in" })}
                    >
                      <option value="inherit">Staff toggle</option>
                      <option value="in">Always available</option>
                      <option value="out">Unavailable</option>
                    </select>
                  </td>
                  <td>
                    <label className="chk">
                      <input type="checkbox" checked={!r.isHidden} onChange={(e) => save(r, { isHidden: !e.target.checked })} /> Show
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
