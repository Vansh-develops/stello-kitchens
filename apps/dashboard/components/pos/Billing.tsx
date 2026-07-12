"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AreaDto,
  AuthUser,
  ComboDto,
  ComboOrderInput,
  MenuCategoryDto,
  MenuItemDto,
  OrderDto,
  OrderItemInput,
  OutletDto,
} from "@stello/shared";
import type { CashSessionDto } from "@stello/shared";
import { posApi as api } from "@/lib/pos-api";
import { ItemDialog } from "./ItemDialog";
import { ComboDialog, type ComboLine } from "./ComboDialog";
import { SettleDialog } from "./SettleDialog";
import { CashDrawer } from "./CashDrawer";

type ItemCartLine = {
  kind: "item";
  key: string;
  name: string;
  itemId: string;
  variationId?: string;
  addonIds: string[];
  quantity: number;
  note?: string;
  variationName: string | null;
  addonNames: string[];
  unitPrice: number;
};
type ComboCartLine = {
  kind: "combo";
  key: string;
  name: string;
  comboId: string;
  quantity: number;
  selections: { slotId: string; itemId: string }[];
  componentNames: string[];
  note?: string;
  unitPrice: number;
};
type CartLine = ItemCartLine | ComboCartLine;

const rupee = (n: number) => `₹${n.toFixed(2)}`;

export function Billing({
  user,
  outlet,
}: {
  user: AuthUser;
  outlet: OutletDto;
}) {
  const [menu, setMenu] = useState<MenuCategoryDto[]>([]);
  const [areas, setAreas] = useState<AreaDto[]>([]);
  const [openOrders, setOpenOrders] = useState<OrderDto[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Working order state
  const [orderType, setOrderType] = useState<"DINE_IN" | "TAKEAWAY" | "DELIVERY">("DINE_IN");
  const [tableId, setTableId] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<OrderDto | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

  const [dialogItem, setDialogItem] = useState<MenuItemDto | null>(null);
  const [dialogCombo, setDialogCombo] = useState<ComboDto | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawer, setDrawer] = useState<CashSessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDrawer = useCallback(() => {
    void api.cashCurrent(outlet.id).then(setDrawer).catch(() => setDrawer(null));
  }, [outlet.id]);
  useEffect(() => {
    loadDrawer();
  }, [loadDrawer]);

  const loadMenu = useCallback(async () => {
    const [m, a, o] = await Promise.all([
      api.menu(outlet.id),
      api.tables(outlet.id),
      api.openOrders(outlet.id),
    ]);
    setMenu(m);
    setAreas(a);
    setOpenOrders(o);
    setActiveCategory((c) => c ?? m[0]?.id ?? null);
  }, [outlet.id]);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  const refreshOrders = useCallback(async () => {
    setOpenOrders(await api.openOrders(outlet.id));
    setAreas(await api.tables(outlet.id));
  }, [outlet.id]);

  const startNew = () => {
    setActiveOrder(null);
    setCart([]);
    setTableId(null);
    setCustomerName("");
    setCustomerPhone("");
    setOrderType("DINE_IN");
    setError(null);
  };

  const openExisting = async (orderId: string) => {
    const order = await api.order(orderId);
    setActiveOrder(order);
    setCart([]);
    setOrderType(order.orderType);
    setTableId(order.tableId);
    setCustomerName(order.customerName ?? "");
    setCustomerPhone(order.customerPhone ?? "");
    setError(null);
  };

  const key = () => `${Date.now()}-${Math.random()}`;

  const addItemLine = (item: MenuItemDto, line: Omit<ItemCartLine, "key" | "name" | "kind">) => {
    setCart((prev) => [...prev, { ...line, kind: "item", key: key(), name: item.name }]);
  };

  const addComboLine = (combo: ComboDto, line: ComboLine) => {
    setCart((prev) => [...prev, { ...line, kind: "combo", key: key(), name: combo.name }]);
  };

  const quickAdd = (item: MenuItemDto) => {
    if (item.variations.length > 0 || item.addonGroups.length > 0) {
      setDialogItem(item);
      return;
    }
    addItemLine(item, {
      itemId: item.id,
      quantity: 1,
      addonIds: [],
      variationName: null,
      addonNames: [],
      unitPrice: item.price,
    });
  };

  const changeQty = (key: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  };

  const cartSubtotal = useMemo(
    () => cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
    [cart],
  );

  const toPayload = (): { items: OrderItemInput[]; combos: ComboOrderInput[] } => {
    const items: OrderItemInput[] = [];
    const combos: ComboOrderInput[] = [];
    for (const l of cart) {
      if (l.kind === "combo") {
        combos.push({ comboId: l.comboId, quantity: l.quantity, selections: l.selections, note: l.note });
      } else {
        items.push({
          itemId: l.itemId,
          variationId: l.variationId,
          addonIds: l.addonIds,
          quantity: l.quantity,
          note: l.note,
        });
      }
    }
    return { items, combos };
  };

  const sendKot = async () => {
    if (cart.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const payload = toPayload();
      if (activeOrder) {
        const updated = await api.addItems(activeOrder.id, payload);
        setActiveOrder(updated);
      } else {
        if (orderType === "DINE_IN" && !tableId) {
          setError("Pick a table for dine-in orders.");
          setBusy(false);
          return;
        }
        const created = await api.createOrder({
          outletId: outlet.id,
          orderType,
          tableId: tableId ?? undefined,
          customerName: customerName || undefined,
          customerPhone: customerPhone || undefined,
          ...payload,
        });
        setActiveOrder(created);
      }
      setCart([]);
      await refreshOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send KOT");
    } finally {
      setBusy(false);
    }
  };

  const onSettled = async (order: OrderDto) => {
    setSettleOpen(false);
    setActiveOrder(null);
    setCart([]);
    startNew();
    await refreshOrders();
    loadDrawer();
    setLastBill(order);
  };
  const [lastBill, setLastBill] = useState<OrderDto | null>(null);

  const cancelOrder = async () => {
    if (!activeOrder) return;
    if (!confirm(`Cancel order${activeOrder.tableName ? " on " + activeOrder.tableName : ""}?`)) return;
    setBusy(true);
    try {
      await api.cancel(activeOrder.id);
      startNew();
      await refreshOrders();
    } finally {
      setBusy(false);
    }
  };

  const filteredItems = (cat: MenuCategoryDto): MenuItemDto[] => {
    if (!search.trim()) return cat.items;
    const q = search.trim().toLowerCase();
    return cat.items.filter(
      (i) => i.name.toLowerCase().includes(q) || i.shortCode?.toLowerCase().includes(q),
    );
  };

  const searchHits = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.trim().toLowerCase();
    return menu
      .flatMap((c) => c.items)
      .filter((i) => i.name.toLowerCase().includes(q) || i.shortCode?.toLowerCase().includes(q));
  }, [search, menu]);

  const activeCat = menu.find((c) => c.id === activeCategory);

  // Existing committed items (already sent to kitchen) + new cart = full running bill
  const committed = activeOrder?.items ?? [];
  const canSettle = activeOrder && committed.length > 0 && cart.length === 0;

  return (
    <div className="pos">
      <aside className="rail">
        <div className="rail-top">
          <span className="wordmark">SPICE<br />ROUTE</span>
          <span className="rail-outlet">{outlet.name.replace("Stello Kitchens - ", "")}</span>
        </div>
        <nav className="cat-nav">
          {menu.map((c) => (
            <button
              key={c.id}
              className={`cat-btn ${c.id === activeCategory && !search ? "active" : ""}`}
              onClick={() => {
                setActiveCategory(c.id);
                setSearch("");
              }}
            >
              <span className="cat-name">{c.name}</span>
              <span className="cat-count">{c.items.length}</span>
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <span className="rail-user">{user.name}</span>
          <span className="rail-role">{user.roleName}</span>
          <button className={`drawer-chip ${drawer ? "open" : "closed"}`} onClick={() => setDrawerOpen(true)}>
            <span className="drawer-dot" />
            {drawer ? `Drawer ₹${drawer.expectedCash.toFixed(0)}` : "Drawer closed"}
          </button>
        </div>
      </aside>

      <main className="menu-pane">
        <div className="menu-head">
          <input
            className="search"
            placeholder="Search item or shortcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="open-orders">
            <span className="oo-label">Running</span>
            {openOrders.length === 0 && <span className="oo-empty">No open tables</span>}
            {openOrders.map((o) => (
              <button
                key={o.id}
                className={`oo-chip ${activeOrder?.id === o.id ? "active" : ""}`}
                onClick={() => openExisting(o.id)}
                title={rupee(o.total)}
              >
                {o.tableName ?? o.orderType.replace("_", " ").toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="item-grid">
          {!search &&
            (activeCat?.combos ?? []).map((combo) => (
              <button
                key={combo.id}
                className={`item-card combo-card ${!combo.inStock ? "oos" : ""}`}
                disabled={!combo.inStock}
                onClick={() => setDialogCombo(combo)}
              >
                <span className="combo-tag">COMBO</span>
                <span className={`veg-dot ${combo.isVeg ? "veg" : "nonveg"}`} />
                <span className="item-name">{combo.name}</span>
                <span className="item-foot">
                  <span className="item-code">{combo.slots.length} picks</span>
                  <span className="item-price">{rupee(combo.price)}</span>
                </span>
                {!combo.inStock && <span className="oos-tag">86'd</span>}
              </button>
            ))}
          {(searchHits ?? activeCat?.items ?? []).map((item) => (
            <button
              key={item.id}
              className={`item-card ${!item.inStock ? "oos" : ""}`}
              disabled={!item.inStock}
              onClick={() => quickAdd(item)}
            >
              <span className={`veg-dot ${item.isVeg ? "veg" : "nonveg"}`} />
              <span className="item-name">{item.name}</span>
              <span className="item-foot">
                <span className="item-code">{item.shortCode}</span>
                <span className="item-price">
                  {item.variations.length ? `${rupee(item.variations[0].price)}+` : rupee(item.price)}
                </span>
              </span>
              {!item.inStock && <span className="oos-tag">86'd</span>}
            </button>
          ))}
          {searchHits?.length === 0 && <p className="empty-search">No items match “{search}”.</p>}
        </div>
      </main>

      <section className="bill-pane">
        <div className="bill-head">
          <div className="order-type-tabs">
            {(["DINE_IN", "TAKEAWAY", "DELIVERY"] as const).map((t) => (
              <button
                key={t}
                className={`ot-tab ${orderType === t ? "active" : ""}`}
                disabled={!!activeOrder}
                onClick={() => {
                  setOrderType(t);
                  if (t !== "DINE_IN") setTableId(null);
                }}
              >
                {t === "DINE_IN" ? "Dine-in" : t === "TAKEAWAY" ? "Takeaway" : "Delivery"}
              </button>
            ))}
          </div>
          {activeOrder ? (
            <div className="bill-ctx">
              <span className="ctx-main">
                {activeOrder.tableName ?? activeOrder.orderType.replace("_", " ")}
              </span>
              <span className="ctx-sub">Bill running · {activeOrder.kots.length} KOT(s)</span>
            </div>
          ) : orderType === "DINE_IN" ? (
            <TablePicker areas={areas} tableId={tableId} onPick={setTableId} />
          ) : (
            <div className="cust-fields">
              <input
                placeholder="Customer name"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
              <input
                placeholder="Phone"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="bill-lines">
          {committed.length > 0 && (
            <div className="line-group">
              <span className="group-label">Sent to kitchen</span>
              {committed.map((i) =>
                i.isComboComponent ? (
                  <div key={i.id} className="bill-line committed combo-comp">
                    <span className="bl-qty">↳</span>
                    <span className="bl-name">{i.itemName}</span>
                    <span className="bl-amt" />
                  </div>
                ) : (
                  <div key={i.id} className="bill-line committed">
                    <span className="bl-qty">{i.quantity}×</span>
                    <span className="bl-name">
                      {i.comboName && <span className="combo-badge">COMBO</span>} {i.itemName}
                      {i.variationName && <em> · {i.variationName}</em>}
                      {i.addonNames.length > 0 && <small>{i.addonNames.join(", ")}</small>}
                      {i.note && <small className="bl-note">“{i.note}”</small>}
                      {i.kotNumber != null && <span className="kot-tag">KOT {i.kotNumber}</span>}
                    </span>
                    <span className="bl-amt">{rupee(i.lineTotal)}</span>
                  </div>
                ),
              )}
            </div>
          )}

          {cart.length > 0 && (
            <div className="line-group">
              <span className="group-label new">New — not yet sent</span>
              {cart.map((l) => (
                <div key={l.key} className="bill-line">
                  <span className="bl-stepper">
                    <button onClick={() => changeQty(l.key, -1)}>–</button>
                    <span>{l.quantity}</span>
                    <button onClick={() => changeQty(l.key, +1)}>+</button>
                  </span>
                  <span className="bl-name">
                    {l.kind === "combo" ? (
                      <>
                        <span className="combo-badge">COMBO</span> {l.name}
                        <small>{l.componentNames.join(" · ")}</small>
                      </>
                    ) : (
                      <>
                        {l.name}
                        {l.variationName && <em> · {l.variationName}</em>}
                        {l.addonNames.length > 0 && <small>{l.addonNames.join(", ")}</small>}
                      </>
                    )}
                  </span>
                  <span className="bl-amt">{rupee(l.unitPrice * l.quantity)}</span>
                </div>
              ))}
            </div>
          )}

          {committed.length === 0 && cart.length === 0 && (
            <div className="bill-empty">
              <p>Tap items to start a bill.</p>
              {lastBill && (
                <div className="last-bill">
                  <span>Last bill settled</span>
                  <strong>
                    {lastBill.billNumber} · {rupee(lastBill.total)}
                  </strong>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="bill-foot">
          {error && <p className="form-error">{error}</p>}
          <div className="totals">
            <div className="tot-row">
              <span>New items</span>
              <span>{rupee(cartSubtotal)}</span>
            </div>
            {activeOrder && (
              <div className="tot-row">
                <span>Running total (incl. tax)</span>
                <span>{rupee(activeOrder.total)}</span>
              </div>
            )}
          </div>
          <div className="bill-buttons">
            <button className="btn-ghost" onClick={startNew} disabled={busy}>
              New
            </button>
            {activeOrder && user.permissions.some((p) => p === "*" || p === "orders.cancel") && (
              <button className="btn-ghost danger" onClick={cancelOrder} disabled={busy}>
                Void
              </button>
            )}
            <button className="btn-kot" onClick={sendKot} disabled={busy || cart.length === 0}>
              {busy ? "…" : activeOrder ? "Add KOT" : "Send KOT"}
            </button>
            <button
              className="btn-primary"
              onClick={() => setSettleOpen(true)}
              disabled={!canSettle || busy}
              title={cart.length > 0 ? "Send pending items first" : undefined}
            >
              Settle {activeOrder ? rupee(activeOrder.total) : ""}
            </button>
          </div>
        </div>
      </section>

      {dialogItem && (
        <ItemDialog
          item={dialogItem}
          onClose={() => setDialogItem(null)}
          onAdd={(line) => {
            addItemLine(dialogItem, line);
            setDialogItem(null);
          }}
        />
      )}

      {dialogCombo && (
        <ComboDialog
          combo={dialogCombo}
          onClose={() => setDialogCombo(null)}
          onAdd={(line) => {
            addComboLine(dialogCombo, line);
            setDialogCombo(null);
          }}
        />
      )}

      {settleOpen && activeOrder && (
        <SettleDialog
          order={activeOrder}
          outletId={outlet.id}
          onClose={() => setSettleOpen(false)}
          onSettled={onSettled}
        />
      )}

      {drawerOpen && (
        <CashDrawer outletId={outlet.id} onClose={() => setDrawerOpen(false)} onChanged={loadDrawer} />
      )}
    </div>
  );
}

function TablePicker({
  areas,
  tableId,
  onPick,
}: {
  areas: AreaDto[];
  tableId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="table-picker">
      {areas.map((area) => (
        <div key={area.id} className="tp-area">
          <span className="tp-area-name">{area.name}</span>
          <div className="tp-tables">
            {area.tables.map((t) => (
              <button
                key={t.id}
                className={`tp-table ${t.occupiedByOrderId ? "occupied" : ""} ${
                  tableId === t.id ? "picked" : ""
                }`}
                disabled={!!t.occupiedByOrderId}
                onClick={() => onPick(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
