"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { isItemAvailableAt } from "@stello/shared";
import type {
  AreaDto,
  AuthUser,
  BillingSettingsDto,
  ParkedCartDto,
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
import { ClockDialog } from "./ClockDialog";
import { TransferDialog } from "./TransferDialog";
import { SplitDialog } from "./SplitDialog";
import { ParkedPanel } from "./ParkedPanel";
import { usePrintStation } from "@/lib/print/station";
import { afterSettlePrint, printBillNow, reprintKotNow } from "@/lib/print/actions";
import { PrintPanel } from "../printing/PrintPanel";
import { publishCfdCart } from "@/lib/cfd-mirror";

/** A table handed over from the floor / reservations screens (nonce re-triggers). */
export type BillingIntent = { nonce: number; orderId?: string; tableId?: string; customerName?: string; customerPhone?: string };

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
const can = (user: AuthUser, perm: string) => user.permissions.some((p) => p === "*" || p === perm);

export function Billing({
  user,
  outlet,
  intent,
}: {
  user: AuthUser;
  outlet: OutletDto;
  intent?: BillingIntent | null;
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const canClock = user.permissions.includes("*") || user.permissions.includes("attendance.clock");
  const [drawer, setDrawer] = useState<CashSessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const station = usePrintStation(outlet.id);
  const [printOpen, setPrintOpen] = useState(false);
  const printAction = (fn: () => Promise<void>) => {
    fn().catch((err) => setError(err instanceof Error ? err.message : "Could not print"));
  };

  // Billing controls
  const [settings, setSettings] = useState<BillingSettingsDto | null>(null);
  const [parked, setParked] = useState<ParkedCartDto[]>([]);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [settleOrder, setSettleOrder] = useState<OrderDto | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const canPark = can(user, "orders.park");

  const loadDrawer = useCallback(() => {
    void api.cashCurrent(outlet.id).then(setDrawer).catch(() => setDrawer(null));
  }, [outlet.id]);
  useEffect(() => {
    loadDrawer();
  }, [loadDrawer]);

  const loadParked = useCallback(async () => {
    if (!canPark) return;
    setParked(await api.parked(outlet.id).catch(() => []));
  }, [outlet.id, canPark]);

  const loadMenu = useCallback(async () => {
    const [m, a, o, st] = await Promise.all([
      api.menu(outlet.id),
      api.tables(outlet.id),
      api.openOrders(outlet.id),
      api.billingSettings(outlet.id).catch(() => null),
    ]);
    setMenu(m);
    setAreas(a);
    setOpenOrders(o);
    setSettings(st);
    setActiveCategory((c) => c ?? m[0]?.id ?? null);
    void loadParked();
  }, [outlet.id, loadParked]);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  const refreshOrders = useCallback(async () => {
    setOpenOrders(await api.openOrders(outlet.id));
    setAreas(await api.tables(outlet.id));
    void loadParked();
  }, [outlet.id, loadParked]);

  // Real-time: other terminals park/resume/move/split bills — refetch on signal.
  useEffect(() => {
    const authToken = typeof window !== "undefined" ? localStorage.getItem("stello.token") : null;
    const socketOrigin =
      process.env.NEXT_PUBLIC_SOCKET_ORIGIN ??
      (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? `${window.location.protocol}//${window.location.hostname}:3001`
        : undefined);
    const socket: Socket = io(socketOrigin, { path: "/socket.io", transports: ["websocket", "polling"], auth: { token: authToken } });
    socket.on("connect", () => socket.emit("join", { outletId: outlet.id }));
    socket.on("kds:changed", (msg: { outletId: string }) => {
      if (msg.outletId === outlet.id) void refreshOrders().catch(() => undefined);
    });
    return () => {
      socket.close();
    };
  }, [outlet.id, refreshOrders]);

  // Keep the open bill in step with changes made elsewhere (merge, split, settle).
  useEffect(() => {
    if (!activeOrder) return;
    const fresh = openOrders.find((o) => o.id === activeOrder.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(activeOrder)) setActiveOrder(fresh);
  }, [openOrders]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Open the table/order chosen on the floor or seated from a reservation.
  useEffect(() => {
    if (!intent) return;
    if (intent.orderId) {
      void openExisting(intent.orderId);
      return;
    }
    startNew();
    setTableId(intent.tableId ?? null);
    setCustomerName(intent.customerName ?? "");
    setCustomerPhone(intent.customerPhone ?? "");
    void refreshOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.nonce]);

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
      station.kick(); // the API queued this KOT for its station printers
      await refreshOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send KOT");
    } finally {
      setBusy(false);
    }
  };

  const onSettled = async (order: OrderDto) => {
    setActiveOrder(null);
    setCart([]);
    startNew();
    await refreshOrders();
    loadDrawer();
    setLastBill(order);
    printAction(() => afterSettlePrint(outlet.id, order.id, station));
  };
  const [lastBill, setLastBill] = useState<OrderDto | null>(null);

  /** Park the current cart server-side with a label; any terminal can resume it. */
  const parkCart = async () => {
    if (cart.length === 0) return;
    const fallback =
      activeOrder?.tableName ?? (customerName || areas.flatMap((a) => a.tables).find((t) => t.id === tableId)?.name || "Order");
    const label = window.prompt("Label for this held order", fallback);
    if (!label?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.park(outlet.id, {
        label: label.trim(),
        orderType: activeOrder?.orderType ?? orderType,
        tableId: (activeOrder?.tableId ?? tableId) || undefined,
        orderId: activeOrder?.id,
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
        lines: cart.map((l) =>
          l.kind === "combo"
            ? { kind: "combo" as const, comboId: l.comboId, quantity: l.quantity, selections: l.selections, note: l.note, name: l.name, componentNames: l.componentNames, unitPrice: l.unitPrice }
            : { kind: "item" as const, itemId: l.itemId, variationId: l.variationId, addonIds: l.addonIds, quantity: l.quantity, note: l.note, name: l.name, variationName: l.variationName, addonNames: l.addonNames, unitPrice: l.unitPrice },
        ),
      });
      startNew();
      await loadParked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not hold the order");
    } finally {
      setBusy(false);
    }
  };

  const resumeParked = async (p: ParkedCartDto) => {
    setParkedOpen(false);
    if (p.orderId) {
      await openExisting(p.orderId).catch(() => startNew());
    } else {
      startNew();
      setOrderType(p.orderType);
      setTableId(p.tableId);
      setCustomerName(p.customerName ?? "");
      setCustomerPhone(p.customerPhone ?? "");
    }
    setCart(
      p.lines.map((l): CartLine =>
        l.kind === "combo"
          ? { kind: "combo", key: key(), name: l.name, comboId: l.comboId, quantity: l.quantity, selections: l.selections, componentNames: l.componentNames, note: l.note, unitPrice: l.unitPrice }
          : { kind: "item", key: key(), name: l.name, itemId: l.itemId, variationId: l.variationId, addonIds: l.addonIds, quantity: l.quantity, note: l.note, variationName: l.variationName, addonNames: l.addonNames, unitPrice: l.unitPrice },
      ),
    );
    await loadParked();
  };

  const openSettle = async (orderId: string) => {
    setError(null);
    try {
      setSettleOrder(await api.order(orderId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the check");
    }
  };

  const unsplit = async () => {
    if (!activeOrder) return;
    setBusy(true);
    try {
      setActiveOrder(await api.unsplit(activeOrder.id));
      await refreshOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not undo the split");
    } finally {
      setBusy(false);
    }
  };

  const cancelOrder = async () => {
    if (!activeOrder) return;
    if (!confirm(`Cancel order${activeOrder.tableName ? " on " + activeOrder.tableName : ""}?`)) return;
    setBusy(true);
    try {
      await api.cancel(activeOrder.id);
      station.kick(); // cancellation KOTs tell the kitchen to stop
      startNew();
      await refreshOrders();
    } finally {
      setBusy(false);
    }
  };

  // Items outside their sale window (outlet-local time) are hidden.
  const sellable = useCallback(
    (i: MenuItemDto) => !settings || isItemAvailableAt(i, now, settings.timezone),
    [settings, now],
  );

  const filteredItems = (cat: MenuCategoryDto): MenuItemDto[] => {
    if (!search.trim()) return cat.items.filter(sellable);
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
      .filter(sellable)
      .filter((i) => i.name.toLowerCase().includes(q) || i.shortCode?.toLowerCase().includes(q));
  }, [search, menu, sellable]);

  const activeCat = menu.find((c) => c.id === activeCategory);

  // Existing committed items (already sent to kitchen) + new cart = full running bill
  const committed = activeOrder?.items ?? [];
  const isSplit = !!activeOrder?.splitCount;
  const canSettle = activeOrder && committed.length > 0 && cart.length === 0 && !isSplit;
  const canOperate = !!activeOrder && !isSplit && !activeOrder.parentOrderId && cart.length === 0 && committed.length > 0;

  // Mirror the running bill to a paired customer-facing display.
  useEffect(() => {
    if (!activeOrder && cart.length === 0) return publishCfdCart(null);
    const lines = [
      ...committed.filter((i) => !i.isComboComponent).map((i) => ({
        name: i.itemName,
        detail: [i.variationName, ...i.addonNames].filter(Boolean).join(", ") || null,
        quantity: i.quantity,
        amount: i.lineTotal,
      })),
      ...cart.map((l) => ({
        name: l.name,
        detail: l.kind === "combo" ? l.componentNames.join(" · ") : [l.variationName, ...l.addonNames].filter(Boolean).join(", ") || null,
        quantity: l.quantity,
        amount: l.unitPrice * l.quantity,
        pending: true,
      })),
    ];
    const pending = cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    publishCfdCart({
      label: activeOrder?.tableName ?? (tableId ? (areas.flatMap((a) => a.tables).find((t) => t.id === tableId)?.name ?? null) : null),
      lines,
      subtotal: (activeOrder?.subtotal ?? 0) + pending,
      discount: activeOrder?.discountAmount ?? 0,
      tax: activeOrder?.taxAmount ?? 0,
      total: (activeOrder?.total ?? 0) + pending,
    });
  }, [activeOrder, cart, committed, tableId, areas]);

  return (
    <div className="pos">
      <aside className="rail">
        <div className="rail-top">
          <span className="wordmark">{outlet.brandName}</span>
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
              <span className="cat-count">{c.items.filter(sellable).length}</span>
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <span className="rail-user">{user.name}</span>
          <span className="rail-role">{user.roleName}</span>
          <button
            className={`drawer-chip ${station.lastError ? "closed" : "open"}`}
            onClick={() => setPrintOpen(true)}
            title={station.lastError ?? "Printing"}
          >
            <span className="drawer-dot" />
            {station.lastError ? "Printer issue" : "Printing"}
          </button>
          <button className={`drawer-chip ${drawer ? "open" : "closed"}`} onClick={() => setDrawerOpen(true)}>
            <span className="drawer-dot" />
            {drawer ? `Drawer ₹${drawer.expectedCash.toFixed(0)}` : "Drawer closed"}
          </button>
          {canClock && (
            <button className="drawer-chip" onClick={() => setClockOpen(true)}>
              Clock in / out
            </button>
          )}
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
            {openOrders
              .filter((o) => !o.parentOrderId)
              .map((o) => (
                <button
                  key={o.id}
                  className={`oo-chip ${activeOrder?.id === o.id ? "active" : ""}`}
                  onClick={() => openExisting(o.id)}
                  title={rupee(o.total)}
                >
                  {o.tableName ?? o.orderType.replace("_", " ").toLowerCase()}
                  {o.splitCount ? <span className="oo-split">÷{o.splitCount}</span> : null}
                </button>
              ))}
            {canPark && (
              <button className={`oo-chip held ${parked.length ? "has" : ""}`} onClick={() => setParkedOpen(true)}>
                Held {parked.length}
              </button>
            )}
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
          {(searchHits ?? (activeCat ? filteredItems(activeCat) : [])).map((item) => (
            <button
              key={item.id}
              className={`item-card ${!item.inStock ? "oos" : ""}`}
              disabled={!item.inStock}
              onClick={() => quickAdd(item)}
            >
              {item.imageUrl && <img className="item-thumb" src={item.imageUrl} alt="" loading="lazy" />}
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
          {!search && activeCat && activeCat.items.length > 0 && filteredItems(activeCat).length === 0 && (
            <p className="empty-search">Nothing in {activeCat.name} is served right now.</p>
          )}
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
              <span className="ctx-sub">
                {isSplit ? `Split into ${activeOrder.splitCount} checks` : `Bill running · ${activeOrder.kots.length} KOT(s)`}
              </span>
              {(canOperate || isSplit) && (
                <div className="ctx-actions">
                  {canOperate && can(user, "orders.transfer") && (
                    <button className="co-apply" onClick={() => setTransferOpen(true)} disabled={busy}>
                      Move / merge
                    </button>
                  )}
                  {canOperate && can(user, "orders.split") && (
                    <button className="co-apply" onClick={() => setSplitOpen(true)} disabled={busy}>
                      Split
                    </button>
                  )}
                  {isSplit && can(user, "orders.split") && activeOrder.splitChildren?.every((c) => c.status === "OPEN") && (
                    <button className="co-apply" onClick={unsplit} disabled={busy}>
                      Undo split
                    </button>
                  )}
                </div>
              )}
              <span className="ctx-print">
                <button className="prn-mini" onClick={() => printAction(() => printBillNow(outlet.id, activeOrder.id, station))}>
                  Print bill
                </button>
                {activeOrder.kots.map((k) => (
                  <button
                    key={k.id}
                    className="prn-mini"
                    title={`Reprint KOT ${k.kotNumber}`}
                    onClick={() => printAction(() => reprintKotNow(outlet.id, k.id, station))}
                  >
                    ⎙ KOT {k.kotNumber}
                  </button>
                ))}
              </span>
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
          {isSplit && (
            <div className="line-group split-checks">
              <span className="group-label">Checks</span>
              {activeOrder.splitChildren?.map((c) => (
                <div key={c.id} className={`check-row ${c.status === "SETTLED" ? "done" : ""}`}>
                  <span className="bl-name">
                    Check {c.splitIndex}
                    <small>{c.status === "SETTLED" ? `Settled · ${c.billNumber}` : "Open"}</small>
                  </span>
                  <span className="bl-amt">{rupee(c.total)}</span>
                  {c.status === "OPEN" && can(user, "orders.settle") && (
                    <button className="btn-primary check-settle" onClick={() => void openSettle(c.id)}>
                      Settle
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

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
            {activeOrder && !!activeOrder.serviceChargeAmount && (
              <div className="tot-row">
                <span>Service charge {activeOrder.serviceChargePercent}%</span>
                <span>{rupee(activeOrder.serviceChargeAmount)}</span>
              </div>
            )}
            {activeOrder && !!activeOrder.roundOff && (
              <div className="tot-row">
                <span>Round off</span>
                <span>{rupee(activeOrder.roundOff)}</span>
              </div>
            )}
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
            {canPark && cart.length > 0 && (
              <button className="btn-ghost" onClick={parkCart} disabled={busy} title="Hold this cart for later, on any terminal">
                Hold
              </button>
            )}
            <button className="btn-kot" onClick={sendKot} disabled={busy || cart.length === 0 || isSplit}>
              {busy ? "…" : activeOrder ? "Add KOT" : "Send KOT"}
            </button>
            <button
              className="btn-primary"
              onClick={() => activeOrder && setSettleOrder(activeOrder)}
              disabled={!canSettle || busy}
              title={cart.length > 0 ? "Send pending items first" : isSplit ? "Settle each check" : undefined}
            >
              {isSplit ? "Settle checks above" : `Settle ${activeOrder ? rupee(activeOrder.total) : ""}`}
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

      {settleOrder && (
        <SettleDialog
          order={settleOrder}
          outletId={outlet.id}
          canRemoveServiceCharge={can(user, "orders.service_charge.remove")}
          onClose={() => setSettleOrder(null)}
          onOrderChanged={(o) => {
            if (activeOrder?.id === o.id) setActiveOrder(o);
            void refreshOrders();
          }}
          onSettled={async (o) => {
            setSettleOrder(null);
            if (o.parentOrderId && activeOrder) {
              // A split check: stay on the parent until every check is settled.
              setLastBill(o);
              await refreshOrders();
              loadDrawer();
              const parent = await api.order(activeOrder.id).catch(() => null);
              if (parent && parent.status === "OPEN") setActiveOrder(parent);
              else startNew();
              return;
            }
            await onSettled(o);
          }}
        />
      )}

      {transferOpen && activeOrder && (
        <TransferDialog
          order={activeOrder}
          areas={areas}
          openOrders={openOrders}
          onClose={() => setTransferOpen(false)}
          onDone={async (focus) => {
            setTransferOpen(false);
            setActiveOrder(focus);
            setTableId(focus.tableId);
            await refreshOrders();
          }}
        />
      )}

      {splitOpen && activeOrder && (
        <SplitDialog
          order={activeOrder}
          onClose={() => setSplitOpen(false)}
          onDone={async (o) => {
            setSplitOpen(false);
            setActiveOrder(o);
            await refreshOrders();
          }}
        />
      )}

      {parkedOpen && (
        <ParkedPanel
          parked={parked}
          onClose={() => setParkedOpen(false)}
          onResume={(p) => void resumeParked(p)}
          onChanged={() => void loadParked()}
        />
      )}

      {clockOpen && <ClockDialog outletId={outlet.id} onClose={() => setClockOpen(false)} />}
      {printOpen && <PrintPanel outletId={outlet.id} station={station} onClose={() => setPrintOpen(false)} />}

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
