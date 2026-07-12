"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AddonGroupAdminDto,
  AdminItemDto,
  AdminMenuDto,
  AuthUser,
  OutletDto,
} from "@stello/shared";
import { api } from "@/lib/api";
import { ItemDialog } from "./ItemDialog";
import { AddonGroupDialog } from "./AddonGroupDialog";
import { InventoryTab } from "./InventoryTab";
import { RecipesTab } from "./RecipesTab";
import { AggregatorsTab } from "./AggregatorsTab";
import { CustomersTab } from "./CustomersTab";
import { MarketingTab } from "./MarketingTab";
import { ReportsTab } from "./ReportsTab";
import { AccountingTab } from "./AccountingTab";
import { CentralKitchenTab } from "./CentralKitchenTab";
import { ScanOrderTab } from "./ScanOrderTab";
import { CombosTab } from "./CombosTab";
import { PrepTab } from "./PrepTab";
import { FleetTab } from "./FleetTab";
import { AppearanceTab } from "./AppearanceTab";
import { InviteStaffTab } from "./InviteStaffTab";

const rupee = (n: number) => `₹${n.toFixed(0)}`;
type Tab =
  | "menu"
  | "addons"
  | "channels"
  | "inventory"
  | "recipes"
  | "online"
  | "customers"
  | "marketing"
  | "reports"
  | "accounting"
  | "central"
  | "scan"
  | "combos"
  | "prep"
  | "fleet"
  | "invite"
  | "settings";

export function Console({
  user,
  outlet,
}: {
  user: AuthUser;
  outlet: OutletDto;
}) {
  const [menu, setMenu] = useState<AdminMenuDto | null>(null);
  const [tab, setTab] = useState<Tab>("menu");
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // dialogs
  const [itemDialog, setItemDialog] = useState<{ item: AdminItemDto | null } | null>(null);
  const [addonDialog, setAddonDialog] = useState<{ group: AddonGroupAdminDto | null } | null>(null);

  // inline states
  const [newCat, setNewCat] = useState("");
  const [renameCat, setRenameCat] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState<{ name: string; kind: "DIRECT" | "AGGREGATOR" }>({
    name: "",
    kind: "AGGREGATOR",
  });

  const reload = useCallback(async () => {
    try {
      const data = await api.adminMenu(outlet.id);
      setMenu(data);
      setSelectedCat((cur) => cur ?? data.categories[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load menu");
    }
  }, [outlet.id]);

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

  const category = useMemo(
    () => menu?.categories.find((c) => c.id === selectedCat) ?? null,
    [menu, selectedCat],
  );
  const channelName = (id: string) => menu?.channels.find((c) => c.id === id)?.name ?? "";

  if (!menu) {
    return <div className="boot">{error ?? "Loading menu…"}</div>;
  }

  return (
    <div className="console">
      <header className="top">
        <div className="top-brand">
          <span className="wordmark">STELLO KITCHENS</span>
          <span className="top-sub">Console · {outlet.name.replace("Stello Kitchens - ", "")}</span>
        </div>
        <nav className="top-tabs">
          {(
            [
              "menu",
              "addons",
              "combos",
              "channels",
              "inventory",
              "recipes",
              "prep",
              "online",
              "customers",
              "marketing",
              "reports",
              "accounting",
              "central",
              "scan",
              "fleet",
              "invite",
              "settings",
            ] as const
          ).map((t) => {
            const labels: Record<string, string> = {
              menu: "Menu",
              addons: "Add-ons",
              combos: "Combos",
              channels: "Channels",
              inventory: "Inventory",
              recipes: "Recipes",
              prep: "Prep",
              online: "Online orders",
              customers: "Customers",
              marketing: "Marketing",
              reports: "Reports",
              accounting: "Accounting",
              central: "Central kitchen",
              scan: "Scan & Order",
              fleet: "Fleet",
              invite: "Invite staff",
              settings: "Settings",
            };
            return (
              <button key={t} className={`top-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                {labels[t]}
              </button>
            );
          })}
        </nav>
        <div className="top-user">
          <span>{user.name}</span>
        </div>
      </header>

      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      {tab === "menu" && (
        <div className="menu-layout">
          <aside className="cat-side">
            <div className="side-head">Categories</div>
            <div className="cat-list">
              {menu.categories.map((c) => (
                <button
                  key={c.id}
                  className={`cat-item ${selectedCat === c.id ? "active" : ""}`}
                  onClick={() => setSelectedCat(c.id)}
                >
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
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newCat.trim()) {
                    void run(() =>
                      api.createCategory(outlet.id, { name: newCat.trim(), sortOrder: menu.categories.length }),
                    );
                    setNewCat("");
                  }
                }}
              />
              <button
                disabled={!newCat.trim()}
                onClick={() => {
                  void run(() =>
                    api.createCategory(outlet.id, { name: newCat.trim(), sortOrder: menu.categories.length }),
                  );
                  setNewCat("");
                }}
              >
                +
              </button>
            </div>
          </aside>

          <main className="items-main">
            {category && (
              <>
                <div className="items-head">
                  {renameCat?.id === category.id ? (
                    <input
                      className="rename-input"
                      autoFocus
                      value={renameCat.name}
                      onChange={(e) => setRenameCat({ id: category.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && renameCat.name.trim()) {
                          void run(() => api.updateCategory(outlet.id, category.id, { name: renameCat.name.trim() }));
                          setRenameCat(null);
                        }
                        if (e.key === "Escape") setRenameCat(null);
                      }}
                      onBlur={() => setRenameCat(null)}
                    />
                  ) : (
                    <h1 onDoubleClick={() => setRenameCat({ id: category.id, name: category.name })}>
                      {category.name}
                    </h1>
                  )}
                  <div className="head-actions">
                    <button
                      className="text-btn"
                      onClick={() => setRenameCat({ id: category.id, name: category.name })}
                    >
                      Rename
                    </button>
                    <button
                      className={`text-btn danger ${confirmDelete === category.id ? "armed" : ""}`}
                      onClick={() =>
                        confirmDelete === category.id
                          ? void run(() => api.deleteCategory(outlet.id, category.id))
                          : setConfirmDelete(category.id)
                      }
                    >
                      {confirmDelete === category.id ? "Confirm delete category" : "Delete category"}
                    </button>
                    <button className="btn-primary sm" onClick={() => setItemDialog({ item: null })}>
                      + Add item
                    </button>
                  </div>
                </div>

                <div className="item-cards">
                  {category.items.map((it) => {
                    const overrides = it.channels.filter((c) => c.price != null);
                    return (
                      <div key={it.id} className={`item-card ${!it.inStock ? "oos" : ""}`}>
                        <div className="ic-top">
                          <span className={`veg-dot ${it.isVeg ? "veg" : "nonveg"}`} />
                          <span className="ic-name">{it.name}</span>
                          {it.shortCode && <span className="ic-code">{it.shortCode}</span>}
                        </div>
                        <div className="ic-price">
                          <strong>{rupee(it.price)}</strong>
                          {it.variations.length > 0 && <span className="ic-meta">{it.variations.length} variations</span>}
                          {it.addonGroupIds.length > 0 && (
                            <span className="ic-meta">{it.addonGroupIds.length} add-on grp</span>
                          )}
                        </div>
                        {(it.availableStart || overrides.length > 0) && (
                          <div className="ic-badges">
                            {it.availableStart && (
                              <span className="badge time">
                                {it.availableStart}–{it.availableEnd}
                              </span>
                            )}
                            {overrides.map((o) => (
                              <span key={o.channelId} className="badge chan">
                                {channelName(o.channelId)} {rupee(o.price!)}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="ic-actions">
                          <button
                            className={`stock-toggle ${it.inStock ? "in" : "out"}`}
                            onClick={() => void run(() => api.toggleStock(outlet.id, it.id, !it.inStock))}
                          >
                            {it.inStock ? "In stock" : "86'd"}
                          </button>
                          <button className="text-btn" onClick={() => setItemDialog({ item: it })}>
                            Edit
                          </button>
                          <button
                            className={`text-btn danger ${confirmDelete === it.id ? "armed" : ""}`}
                            onClick={() =>
                              confirmDelete === it.id
                                ? void run(() => api.deleteItem(outlet.id, it.id))
                                : setConfirmDelete(it.id)
                            }
                          >
                            {confirmDelete === it.id ? "Confirm" : "Delete"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {category.items.length === 0 && <p className="empty">No items yet. Add one to get started.</p>}
                </div>
              </>
            )}
            {!category && <p className="empty">Create a category to start building the menu.</p>}
          </main>
        </div>
      )}

      {tab === "addons" && (
        <div className="tab-pane">
          <div className="pane-head">
            <h1>Add-on groups</h1>
            <button className="btn-primary sm" onClick={() => setAddonDialog({ group: null })}>
              + New group
            </button>
          </div>
          <div className="addon-grid">
            {menu.addonGroups.map((g) => (
              <div key={g.id} className="addon-card">
                <div className="ac-head">
                  <h3>{g.name}</h3>
                  <span className="ac-rule">
                    {g.minSelect}–{g.maxSelect} select
                  </span>
                </div>
                <ul>
                  {g.addons.map((a) => (
                    <li key={a.id}>
                      <span>{a.name}</span>
                      <em>+{rupee(a.price)}</em>
                    </li>
                  ))}
                </ul>
                <div className="ac-actions">
                  <button className="text-btn" onClick={() => setAddonDialog({ group: g })}>
                    Edit
                  </button>
                  <button
                    className={`text-btn danger ${confirmDelete === g.id ? "armed" : ""}`}
                    onClick={() =>
                      confirmDelete === g.id
                        ? void run(() => api.deleteAddonGroup(outlet.id, g.id))
                        : setConfirmDelete(g.id)
                    }
                  >
                    {confirmDelete === g.id ? "Confirm" : "Delete"}
                  </button>
                </div>
              </div>
            ))}
            {menu.addonGroups.length === 0 && <p className="empty">No add-on groups yet.</p>}
          </div>
        </div>
      )}

      {tab === "channels" && (
        <div className="tab-pane">
          <div className="pane-head">
            <h1>Sales channels</h1>
          </div>
          <p className="hint wide">
            Channels drive per-item pricing. Mark aggregator prices up to absorb commission; set external IDs on
            each item so the menu can be pushed to Zomato/Swiggy later.
          </p>
          <div className="channel-list">
            {menu.channels.map((c) => (
              <div key={c.id} className="channel-row">
                <span className={`chan-kind ${c.kind.toLowerCase()}`}>{c.kind}</span>
                <span className="chan-name">{c.name}</span>
                <button
                  className={`chan-active ${c.isActive ? "on" : ""}`}
                  onClick={() => void run(() => api.updateChannel(outlet.id, c.id, { isActive: !c.isActive }))}
                >
                  {c.isActive ? "Active" : "Inactive"}
                </button>
                <button
                  className={`text-btn danger ${confirmDelete === c.id ? "armed" : ""}`}
                  onClick={() =>
                    confirmDelete === c.id
                      ? void run(() => api.deleteChannel(outlet.id, c.id))
                      : setConfirmDelete(c.id)
                  }
                >
                  {confirmDelete === c.id ? "Confirm" : "Delete"}
                </button>
              </div>
            ))}
          </div>
          <div className="add-channel">
            <input
              placeholder="Channel name (e.g. Magicpin)"
              value={newChannel.name}
              onChange={(e) => setNewChannel((p) => ({ ...p, name: e.target.value }))}
            />
            <select
              value={newChannel.kind}
              onChange={(e) => setNewChannel((p) => ({ ...p, kind: e.target.value as "DIRECT" | "AGGREGATOR" }))}
            >
              <option value="AGGREGATOR">Aggregator</option>
              <option value="DIRECT">Direct</option>
            </select>
            <button
              className="btn-primary sm"
              disabled={!newChannel.name.trim()}
              onClick={() => {
                void run(() =>
                  api.createChannel(outlet.id, {
                    name: newChannel.name.trim(),
                    kind: newChannel.kind,
                    isActive: true,
                    sortOrder: menu.channels.length,
                  }),
                );
                setNewChannel({ name: "", kind: "AGGREGATOR" });
              }}
            >
              + Add channel
            </button>
          </div>
        </div>
      )}

      {tab === "inventory" && <InventoryTab outletId={outlet.id} />}
      {tab === "recipes" && <RecipesTab outletId={outlet.id} />}
      {tab === "online" && <AggregatorsTab outletId={outlet.id} />}
      {tab === "customers" && <CustomersTab outletId={outlet.id} />}
      {tab === "marketing" && <MarketingTab outletId={outlet.id} />}
      {tab === "reports" && <ReportsTab outletId={outlet.id} />}
      {tab === "accounting" && <AccountingTab outletId={outlet.id} />}
      {tab === "central" && <CentralKitchenTab outletId={outlet.id} />}
      {tab === "scan" && <ScanOrderTab outletId={outlet.id} />}
      {tab === "combos" && <CombosTab outletId={outlet.id} />}
      {tab === "prep" && <PrepTab outletId={outlet.id} />}
      {tab === "fleet" && <FleetTab outletId={outlet.id} />}
      {tab === "invite" && <InviteStaffTab />}
      {tab === "settings" && <AppearanceTab outlet={outlet} />}

      {itemDialog && (
        <ItemDialog
          outletId={outlet.id}
          item={itemDialog.item}
          defaultCategoryId={selectedCat ?? menu.categories[0]?.id ?? ""}
          categories={menu.categories}
          addonGroups={menu.addonGroups}
          channels={menu.channels}
          onClose={() => setItemDialog(null)}
          onSaved={() => {
            setItemDialog(null);
            void reload();
          }}
        />
      )}

      {addonDialog && (
        <AddonGroupDialog
          outletId={outlet.id}
          group={addonDialog.group}
          onClose={() => setAddonDialog(null)}
          onSaved={() => {
            setAddonDialog(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}
