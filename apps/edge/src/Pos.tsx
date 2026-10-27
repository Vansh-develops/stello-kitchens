import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComboDto, MenuItemDto } from "@stello/shared";
import { computeOrderTotals, fromPaise, toPaise } from "@stello/shared";
import {
  can,
  edge,
  type ComboLineInput,
  type EdgeArea,
  type EdgeCategory,
  type EdgeStatus,
  type ItemLineInput,
  type LocalOrder,
  type LocalOrderRow,
  type OrderType,
  type StaffSession,
} from "./api";
import { ComboDialog, ItemDialog, PayDialog, ReceiptDialog } from "./dialogs";
import { SyncPanel } from "./SyncPanel";

export const rupee = (n: number) => `₹${n.toFixed(2)}`;

export type CartLine = {
  key: string;
  label: string;
  detail: string;
  unitPrice: number;
  taxRate: number;
  qty: number;
  item?: Omit<ItemLineInput, "quantity">;
  combo?: Omit<ComboLineInput, "quantity">;
};

const MODES: { key: OrderType; label: string }[] = [
  { key: "DINE_IN", label: "Dine-in" },
  { key: "TAKEAWAY", label: "Takeaway" },
  { key: "DELIVERY", label: "Delivery" },
];

export function Pos({
  status,
  staff,
  onLogout,
  onStatus,
}: {
  status: EdgeStatus;
  staff: StaffSession;
  onLogout: () => void;
  onStatus: () => Promise<void>;
}) {
  const [menu, setMenu] = useState<EdgeCategory[]>([]);
  const [areas, setAreas] = useState<EdgeArea[]>([]);
  const [running, setRunning] = useState<LocalOrderRow[]>([]);
  const [mode, setMode] = useState<OrderType>("TAKEAWAY");
  const [tableId, setTableId] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<LocalOrder | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState({ name: "", phone: "", address: "" });
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [configItem, setConfigItem] = useState<MenuItemDto | null>(null);
  const [configCombo, setConfigCombo] = useState<ComboDto | null>(null);
  const [paying, setPaying] = useState<LocalOrder | null>(null);
  const [receipt, setReceipt] = useState<LocalOrder | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, a, o] = await Promise.all([edge.menu(), edge.areas(), edge.orders("OPEN")]);
      setMenu(m);
      setAreas(a);
      setRunning(o);
      setActiveCat((c) => (c && m.some((x) => x.id === c) ? c : (m[0]?.id ?? null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, status.lastPullAt]);

  const say = (m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 3000);
  };
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const resetTicket = () => {
    setCart([]);
    setActiveOrder(null);
    setTableId(null);
    setCustomer({ name: "", phone: "", address: "" });
  };

  // ---------- cart ----------
  const addLine = (line: Omit<CartLine, "key">) =>
    setCart((prev) => {
      const sig = JSON.stringify([line.item, line.combo]);
      const found = prev.find((l) => JSON.stringify([l.item, l.combo]) === sig);
      if (found) return prev.map((l) => (l === found ? { ...l, qty: l.qty + line.qty } : l));
      return [...prev, { ...line, key: `${Date.now()}-${Math.random()}` }];
    });
  const tapItem = (item: MenuItemDto) => {
    if (!item.inStock) return;
    if (item.variations.length || item.addonGroups.length) return setConfigItem(item);
    addLine({ label: item.name, detail: "", unitPrice: item.price, taxRate: item.taxRate, qty: 1, item: { itemId: item.id, addonIds: [] } });
  };
  const tapCombo = (combo: ComboDto) => {
    if (!combo.inStock) return;
    if (combo.slots.some((s) => s.options.length > 1)) return setConfigCombo(combo);
    addLine({
      label: combo.name,
      detail: combo.slots.map((s) => s.options[0]?.name).filter(Boolean).join(", "),
      unitPrice: combo.price + combo.slots.reduce((sum, s) => sum + (s.options[0]?.priceDelta ?? 0), 0),
      taxRate: combo.taxRate,
      qty: 1,
      combo: { comboId: combo.id, selections: combo.slots.filter((s) => s.options[0]).map((s) => ({ slotId: s.id, itemId: s.options[0].itemId })) },
    });
  };
  const changeQty = (key: string, d: number) => setCart((prev) => prev.map((l) => (l.key === key ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));

  const payloads = () => ({
    items: cart.filter((l) => l.item).map((l) => ({ ...l.item!, quantity: l.qty })),
    combos: cart.filter((l) => l.combo).map((l) => ({ ...l.combo!, quantity: l.qty })),
  });

  const preview = useMemo(() => {
    const lines = [
      ...(activeOrder?.lines ?? []).map((l) => ({ lineTotalPaise: toPaise(l.lineTotal), taxRatePercent: l.taxRate })),
      ...cart.map((l) => ({ lineTotalPaise: toPaise(l.unitPrice) * l.qty, taxRatePercent: l.taxRate })),
    ];
    return computeOrderTotals(lines, 0);
  }, [cart, activeOrder]);

  // ---------- table / running orders ----------
  const openTable = async (id: string) => {
    const table = areas.flatMap((a) => a.tables).find((t) => t.id === id);
    if (!table) return;
    setCart([]);
    setTableId(id);
    if (table.occupiedByOrderId) {
      const o = await run(() => edge.order(table.occupiedByOrderId!));
      if (o) setActiveOrder(o);
    } else {
      setActiveOrder(null);
    }
  };
  const openRunning = async (row: LocalOrderRow) => {
    const o = await run(() => edge.order(row.clientId));
    if (!o) return;
    setMode(o.orderType);
    setTableId(o.tableId);
    setActiveOrder(o);
    setCart([]);
  };

  // ---------- actions ----------
  /** Fire the cart to the kitchen: opens a new order or adds a round to the running one. */
  const sendKot = async (): Promise<LocalOrder | undefined> => {
    if (!cart.length) return activeOrder ?? undefined;
    const { items, combos } = payloads();
    const order = await run(async () => {
      if (activeOrder) return edge.addItems(activeOrder.clientId, items, combos);
      const table = areas.flatMap((a) => a.tables).find((t) => t.id === tableId);
      let allowCloudOccupied = false;
      if (mode === "DINE_IN" && table?.cloudOccupied) {
        allowCloudOccupied = window.confirm(`${table.name} shows a running order on another terminal (last cloud sync). Open a separate order here anyway?`);
        if (!allowCloudOccupied) throw new Error("Pick another table");
      }
      return edge.createOrder({
        orderType: mode,
        tableId: mode === "DINE_IN" ? (tableId ?? undefined) : undefined,
        customerName: customer.name || undefined,
        customerPhone: customer.phone || undefined,
        deliveryAddress: mode === "DELIVERY" ? customer.address || undefined : undefined,
        items,
        combos,
        allowCloudOccupied,
      });
    });
    if (!order) return undefined;
    setCart([]);
    setActiveOrder(order);
    say(`KOT ${order.kotCount} sent to the kitchen`);
    await load();
    return order;
  };

  const sendAndHold = async () => {
    const o = await sendKot();
    if (o && mode !== "DINE_IN") resetTicket();
  };
  const billNow = async () => {
    const o = await sendKot();
    if (o) setPaying(o);
  };
  const cancelActive = async () => {
    if (!activeOrder) return;
    const reason = window.prompt("Reason for cancelling this order?");
    if (!reason) return;
    const done = await run(() => edge.cancel(activeOrder.clientId, reason));
    if (done) {
      say("Order cancelled — the kitchen tickets were withdrawn");
      resetTicket();
      await load();
      await onStatus();
    }
  };

  const online = status.online && !status.forcedOffline;
  const q = search.trim().toLowerCase();
  const category = menu.find((c) => c.id === activeCat);
  const items = q ? menu.flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(q) || i.shortCode?.toLowerCase() === q) : (category?.items ?? []);
  const combos = q ? menu.flatMap((c) => c.combos).filter((c) => c.name.toLowerCase().includes(q)) : (category?.combos ?? []);
  const table = areas.flatMap((a) => a.tables).find((t) => t.id === tableId) ?? null;
  const showFloor = mode === "DINE_IN" && !tableId;
  const canBill = can(staff, "orders.create");
  const deliveryReady = mode !== "DELIVERY" || activeOrder || (customer.phone.trim() && customer.address.trim());

  return (
    <div className="edge">
      <header className="edge-head">
        <div className="eh-brand">
          <span className="wordmark">STELLO KITCHENS</span>
          <span className="eh-sub">
            EDGE · {status.outletName} · SERIES {status.seriesCode}
          </span>
        </div>
        <div className="eh-status">
          <span className={`net ${online ? "online" : "offline"}`}>
            <span className="net-dot" /> {online ? "ONLINE" : "OFFLINE"}
          </span>
          <button className="outbox" onClick={() => setSyncOpen(true)} title="Sync status">
            Outbox <strong>{status.pending}</strong>
            {status.conflicts > 0 && <span className="badge-warn">{status.conflicts} to review</span>}
          </button>
          <button className="eh-btn ghost" onClick={() => setSyncOpen(true)}>
            Sync &amp; kitchen
          </button>
          <span className="eh-staff">{staff.name}</span>
          <button className="eh-btn ghost" onClick={onLogout}>
            Lock
          </button>
        </div>
      </header>

      {flash && <div className="flash">{flash}</div>}
      {error && (
        <div className="edge-error" onClick={() => setError(null)}>
          {error} — dismiss
        </div>
      )}

      <div className="edge-body">
        <nav className="edge-cats">
          <input className="ecat-search" placeholder="Search / code" value={search} onChange={(e) => setSearch(e.target.value)} />
          {menu.map((c) => (
            <button
              key={c.id}
              className={`ecat ${!q && c.id === activeCat ? "active" : ""}`}
              onClick={() => {
                setSearch("");
                setActiveCat(c.id);
              }}
            >
              {c.name}
            </button>
          ))}
        </nav>

        <main className="edge-main">
          <div className="mode-tabs">
            {MODES.map((m) => (
              <button
                key={m.key}
                className={`mode-tab ${mode === m.key ? "active" : ""}`}
                disabled={!!activeOrder && activeOrder.orderType !== m.key}
                onClick={() => {
                  setMode(m.key);
                  if (!activeOrder) setTableId(null);
                }}
              >
                {m.label}
              </button>
            ))}
            {mode === "DINE_IN" && tableId && (
              <button className="mode-tab ghost" onClick={resetTicket}>
                ← Floor
              </button>
            )}
          </div>

          {showFloor ? (
            <div className="floor">
              {areas.length === 0 && <p className="eb-empty">No tables cached. Add areas and tables in Console, then sync.</p>}
              {areas.map((a) => (
                <section key={a.id}>
                  <h3 className="floor-area">{a.name}</h3>
                  <div className="floor-grid">
                    {a.tables.map((t) => (
                      <button
                        key={t.id}
                        className={`table-tile ${t.occupiedByOrderId ? "busy" : t.cloudOccupied ? "cloud" : ""}`}
                        onClick={() => void openTable(t.id)}
                      >
                        <span className="tt-name">{t.name}</span>
                        <span className="tt-meta">
                          {t.occupiedByOrderId ? rupee(t.runningTotal ?? 0) : t.cloudOccupied ? "busy (cloud)" : `${t.seats} seats`}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="edge-grid">
              {combos.map((c) => (
                <button key={c.id} className={`eitem combo ${c.inStock ? "" : "out"}`} onClick={() => tapCombo(c)} disabled={!c.inStock}>
                  <span className={`veg-dot ${c.isVeg ? "veg" : "nonveg"}`} />
                  <span className="eitem-name">{c.name}</span>
                  <span className="eitem-tag">combo</span>
                  <span className="eitem-price">{c.inStock ? rupee(c.price) : "86'd"}</span>
                </button>
              ))}
              {items.map((it) => (
                <button key={it.id} className={`eitem ${it.inStock ? "" : "out"}`} onClick={() => tapItem(it)} disabled={!it.inStock}>
                  <span className={`veg-dot ${it.isVeg ? "veg" : "nonveg"}`} />
                  <span className="eitem-name">{it.name}</span>
                  {(it.variations.length > 0 || it.addonGroups.length > 0) && <span className="eitem-tag">options</span>}
                  <span className="eitem-price">{it.inStock ? rupee(it.price) : "86'd"}</span>
                </button>
              ))}
              {items.length + combos.length === 0 && <p className="eb-empty">Nothing here.</p>}
            </div>
          )}
        </main>

        <section className="edge-bill">
          <div className="eb-context">
            {mode === "DINE_IN" ? (
              <strong>{table ? `Table ${table.name}` : "Pick a table"}</strong>
            ) : (
              <div className="eb-customer">
                <input placeholder="Customer name" value={activeOrder?.customerName ?? customer.name} disabled={!!activeOrder} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
                <input placeholder={mode === "DELIVERY" ? "Phone (required)" : "Phone"} inputMode="tel" value={activeOrder?.customerPhone ?? customer.phone} disabled={!!activeOrder} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
                {mode === "DELIVERY" && (
                  <textarea placeholder="Delivery address (required)" rows={2} value={activeOrder?.deliveryAddress ?? customer.address} disabled={!!activeOrder} onChange={(e) => setCustomer({ ...customer, address: e.target.value })} />
                )}
              </div>
            )}
            {activeOrder && <span className="faint">Running order · {activeOrder.kotCount} KOT(s)</span>}
          </div>

          <div className="eb-lines">
            {!activeOrder && cart.length === 0 && <p className="eb-empty">Tap items to bill. Works offline — sales queue in the outbox and sync when the internet is back.</p>}
            {activeOrder?.lines.map((l, i) => (
              <div key={`sent-${i}`} className="eb-line sent">
                <span className="eb-qty mono">{l.quantity}×</span>
                <span className="eb-name">
                  {l.itemName}
                  {(l.variationName || l.addonNames.length > 0) && <small>{[l.variationName, ...l.addonNames].filter(Boolean).join(", ")}</small>}
                </span>
                <span className="eb-amt">{rupee(l.lineTotal)}</span>
              </div>
            ))}
            {cart.map((l) => (
              <div key={l.key} className="eb-line">
                <span className="eb-step">
                  <button onClick={() => changeQty(l.key, -1)} aria-label="less">–</button>
                  <span>{l.qty}</span>
                  <button onClick={() => changeQty(l.key, +1)} aria-label="more">+</button>
                </span>
                <span className="eb-name">
                  {l.label}
                  {l.detail && <small>{l.detail}</small>}
                </span>
                <span className="eb-amt">{rupee(fromPaise(toPaise(l.unitPrice) * l.qty))}</span>
              </div>
            ))}
          </div>

          <div className="eb-foot">
            <div className="eb-sum">
              <span>Subtotal</span>
              <span>{rupee(preview.subtotal)}</span>
            </div>
            <div className="eb-sum">
              <span>GST</span>
              <span>{rupee(preview.taxAmount)}</span>
            </div>
            <div className="eb-total">
              <span>Total</span>
              <span>{rupee(preview.total)}</span>
            </div>
            <div className="eb-actions">
              <button className="btn-secondary" onClick={() => void sendAndHold()} disabled={busy || !canBill || cart.length === 0 || (mode === "DINE_IN" && !tableId) || !deliveryReady}>
                Send KOT
              </button>
              <button
                className="btn-primary"
                onClick={() => void billNow()}
                disabled={busy || !can(staff, "orders.settle") || (!activeOrder && cart.length === 0) || (mode === "DINE_IN" && !tableId) || !deliveryReady}
              >
                Bill &amp; pay · {rupee(preview.total)}
              </button>
            </div>
            {activeOrder && (
              <div className="eb-actions">
                <button className="btn-ghost" onClick={resetTicket}>
                  New ticket
                </button>
                {can(staff, "orders.cancel") && (
                  <button className="btn-ghost danger" onClick={() => void cancelActive()}>
                    Cancel order
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="eb-recent">
            <span className="eb-recent-label">Running orders</span>
            {running.length === 0 && <span className="faint">None</span>}
            {running.map((o) => (
              <button key={o.clientId} className={`eb-recent-row ${activeOrder?.clientId === o.clientId ? "active" : ""}`} onClick={() => void openRunning(o)}>
                <span>{o.orderType === "DINE_IN" ? `Table ${o.tableName ?? "?"}` : `${o.orderType === "DELIVERY" ? "Delivery" : "Takeaway"} ${o.customerName ?? ""}`}</span>
                <span className="mono">{rupee(o.total)}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {configItem && (
        <ItemDialog
          item={configItem}
          onClose={() => setConfigItem(null)}
          onAdd={(line) => {
            addLine(line);
            setConfigItem(null);
          }}
        />
      )}
      {configCombo && (
        <ComboDialog
          combo={configCombo}
          onClose={() => setConfigCombo(null)}
          onAdd={(line) => {
            addLine(line);
            setConfigCombo(null);
          }}
        />
      )}
      {paying && (
        <PayDialog
          order={paying}
          onClose={() => setPaying(null)}
          onSettled={async (o) => {
            setPaying(null);
            setReceipt(o);
            resetTicket();
            await load();
            await onStatus();
          }}
        />
      )}
      {receipt && <ReceiptDialog order={receipt} status={status} onClose={() => setReceipt(null)} />}
      {syncOpen && <SyncPanel staff={staff} onClose={() => setSyncOpen(false)} onChanged={onStatus} />}
    </div>
  );
}
