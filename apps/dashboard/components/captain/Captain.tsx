"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AuthUser,
  ComboDto,
  ComboOrderInput,
  FloorTableDto,
  MenuCategoryDto,
  MenuItemDto,
  OrderDto,
  OrderItemInput,
  OutletDto,
} from "@stello/shared";
import { posApi } from "@/lib/pos-api";
import { fohApi } from "@/lib/foh-api";
import { ItemDialog } from "@/components/pos/ItemDialog";
import { ComboDialog, type ComboLine } from "@/components/pos/ComboDialog";
import { LiveFloor } from "@/components/foh/LiveFloor";
import { ServerCallAlerts } from "@/components/foh/ServerCallAlerts";
import { useOutletSocket } from "@/components/foh/useOutletSocket";
import "@/components/pos/pos.css";
import "@/components/foh/foh.css";
import "./captain.css";

type Line =
  | { kind: "item"; key: string; name: string; detail: string; unitPrice: number; quantity: number; input: OrderItemInput }
  | { kind: "combo"; key: string; name: string; detail: string; unitPrice: number; quantity: number; input: ComboOrderInput };

const rupee = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const newKey = () => `${Date.now()}-${Math.random()}`;

/**
 * Captain / waiter mode: a phone-first ordering screen. Pick a table from the
 * live floor, add items (variants, add-ons, notes), fire the KOT, review the
 * table's running order and request the bill.
 */
export function Captain({ user, outlet }: { user: AuthUser; outlet: OutletDto }) {
  const [table, setTable] = useState<FloorTableDto | null>(null);
  const [menu, setMenu] = useState<MenuCategoryDto[]>([]);

  useEffect(() => {
    posApi.menu(outlet.id).then(setMenu).catch(() => setMenu([]));
  }, [outlet.id]);

  return (
    <div className="pos-root captain">
      {table ? (
        <TableOrder user={user} outlet={outlet} table={table} menu={menu} onBack={() => setTable(null)} />
      ) : (
        <div className="cap-floor">
          <h1 className="cap-title">Tables</h1>
          <LiveFloor
            outletId={outlet.id}
            userId={user.id}
            compact
            onOpenOrder={(_id, t) => setTable(t)}
            onStartTable={(t) => setTable(t)}
          />
        </div>
      )}
      <ServerCallAlerts outletId={outlet.id} userId={user.id} />
    </div>
  );
}

function TableOrder({
  user,
  outlet,
  table,
  menu,
  onBack,
}: {
  user: AuthUser;
  outlet: OutletDto;
  table: FloorTableDto;
  menu: MenuCategoryDto[];
  onBack: () => void;
}) {
  const [order, setOrder] = useState<OrderDto | null>(null);
  const [tab, setTab] = useState<"menu" | "order">(table.orderId ? "order" : "menu");
  const [cat, setCat] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<Line[]>([]);
  const [dialogItem, setDialogItem] = useState<MenuItemDto | null>(null);
  const [dialogCombo, setDialogCombo] = useState<ComboDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  // Find this table's running order (it may have been opened elsewhere since).
  const loadOrder = useCallback(async () => {
    const open = await posApi.openOrders(outlet.id);
    const mine = open.find((o) => o.tableId === table.id) ?? null;
    setOrder(mine ? await posApi.order(mine.id) : null);
  }, [outlet.id, table.id]);

  useEffect(() => {
    void loadOrder();
  }, [loadOrder]);
  useOutletSocket(outlet.id, { onChange: () => void loadOrder() });

  useEffect(() => setCat((c) => c ?? menu[0]?.id ?? null), [menu]);

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) return menu.flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(q) || i.shortCode?.toLowerCase().includes(q));
    return menu.find((c) => c.id === cat)?.items ?? [];
  }, [menu, cat, search]);
  const combos = search.trim() ? [] : (menu.find((c) => c.id === cat)?.combos ?? []);

  const addItem = (item: MenuItemDto, line: OrderItemInput & { variationName: string | null; addonNames: string[]; unitPrice: number }) => {
    const { variationName, addonNames, unitPrice, ...input } = line;
    setCart((prev) => [
      ...prev,
      {
        kind: "item",
        key: newKey(),
        name: item.name,
        detail: [variationName, ...addonNames, input.note ? `“${input.note}”` : null].filter(Boolean).join(" · "),
        unitPrice,
        quantity: input.quantity,
        input,
      },
    ]);
  };
  const quickAdd = (item: MenuItemDto) => {
    const needsChoice = item.variations.length > 0 || item.addonGroups.some((g) => g.minSelect > 0);
    if (needsChoice) return setDialogItem(item);
    addItem(item, { itemId: item.id, quantity: 1, addonIds: [], variationName: null, addonNames: [], unitPrice: item.price });
  };
  const addCombo = (combo: ComboDto, line: ComboLine) =>
    setCart((prev) => [
      ...prev,
      {
        kind: "combo",
        key: newKey(),
        name: combo.name,
        detail: line.componentNames.join(" · "),
        unitPrice: line.unitPrice,
        quantity: line.quantity,
        input: { comboId: line.comboId, quantity: line.quantity, selections: line.selections, note: line.note },
      },
    ]);
  const changeQty = (key: string, d: number) =>
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? ({ ...l, quantity: l.quantity + d, input: { ...l.input, quantity: l.quantity + d } } as Line) : l))
        .filter((l) => l.quantity > 0),
    );
  const cartTotal = cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);

  const sendKot = async () => {
    if (!cart.length) return;
    setBusy(true);
    setFlash(null);
    const payload = {
      items: cart.filter((l): l is Extract<Line, { kind: "item" }> => l.kind === "item").map((l) => l.input),
      combos: cart.filter((l): l is Extract<Line, { kind: "combo" }> => l.kind === "combo").map((l) => l.input),
    };
    try {
      const updated = order
        ? await posApi.addItems(order.id, payload)
        : await posApi.createOrder({
            outletId: outlet.id,
            orderType: "DINE_IN",
            tableId: table.id,
            customerName: table.reservation?.guestName,
            ...payload,
          });
      setOrder(updated);
      setCart([]);
      setTab("order");
      setFlash({ ok: true, text: `KOT ${updated.kots[updated.kots.length - 1]?.kotNumber ?? ""} sent to kitchen` });
    } catch (e) {
      setFlash({ ok: false, text: e instanceof Error ? e.message : "Could not send KOT" });
    } finally {
      setBusy(false);
    }
  };

  const requestBill = async () => {
    setBusy(true);
    try {
      await fohApi.requestBill(outlet.id, table.id);
      setFlash({ ok: true, text: "Bill requested — the cashier has been alerted" });
    } catch (e) {
      setFlash({ ok: false, text: e instanceof Error ? e.message : "Could not request bill" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cap-order">
      <header className="cap-head">
        <button className="cap-back" onClick={onBack} aria-label="Back to tables">
          ‹
        </button>
        <div>
          <strong>{table.name}</strong>
          <small>
            {order ? `Running · ${rupee(order.total)} · ${order.kots.length} KOT` : "New order"}
            {table.reservation ? ` · ${table.reservation.guestName}` : ""}
          </small>
        </div>
        <span className="cap-user">{user.name.split(" ")[0]}</span>
      </header>
      <nav className="cap-tabs">
        <button className={tab === "menu" ? "on" : ""} onClick={() => setTab("menu")}>
          Menu
        </button>
        <button className={tab === "order" ? "on" : ""} onClick={() => setTab("order")}>
          Running order{order ? ` (${order.items.filter((i) => !i.isComboComponent).length})` : ""}
        </button>
      </nav>
      {flash && (
        <p className={flash.ok ? "cap-flash ok" : "cap-flash err"} onClick={() => setFlash(null)}>
          {flash.text}
        </p>
      )}

      {tab === "menu" ? (
        <div className="cap-menu">
          <input className="cap-search" placeholder="Search dish or code…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {!search && (
            <div className="cap-cats">
              {menu.map((c) => (
                <button key={c.id} className={c.id === cat ? "on" : ""} onClick={() => setCat(c.id)}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <ul className="cap-items">
            {combos.map((combo) => (
              <li key={combo.id} className={combo.inStock ? "" : "oos"}>
                <button className="cap-item" disabled={!combo.inStock} onClick={() => setDialogCombo(combo)}>
                  <span className="cap-ph combo">COMBO</span>
                  <span className="cap-name">
                    <span className={`veg-dot ${combo.isVeg ? "veg" : "nonveg"}`} /> {combo.name}
                    <small>{combo.slots.length} picks</small>
                  </span>
                  <span className="cap-price">{rupee(combo.price)}</span>
                </button>
              </li>
            ))}
            {items.map((item) => (
              <li key={item.id} className={item.inStock ? "" : "oos"}>
                <button className="cap-item" disabled={!item.inStock} onClick={() => setDialogItem(item)}>
                  {item.imageUrl ? <img className="cap-ph" src={item.imageUrl} alt="" loading="lazy" /> : <span className="cap-ph">{item.name.slice(0, 1)}</span>}
                  <span className="cap-name">
                    <span className={`veg-dot ${item.isVeg ? "veg" : "nonveg"}`} /> {item.name}
                    <small>{item.inStock ? (item.variations.length ? `${item.variations.length} sizes` : item.shortCode ?? "") : "86'd"}</small>
                  </span>
                  <span className="cap-price">{rupee(item.variations[0]?.price ?? item.price)}</span>
                </button>
                {item.inStock && (
                  <button className="cap-plus" onClick={() => quickAdd(item)} aria-label={`Add one ${item.name}`}>
                    +
                  </button>
                )}
              </li>
            ))}
            {items.length === 0 && combos.length === 0 && <li className="cap-empty">Nothing here.</li>}
          </ul>
        </div>
      ) : (
        <div className="cap-running">
          {!order && <p className="cap-empty">No items sent yet for {table.name}.</p>}
          {order?.kots.map((k) => (
            <section key={k.id} className="cap-kot">
              <h3>
                KOT {k.kotNumber} <small>{new Date(k.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · {k.status.toLowerCase()}</small>
              </h3>
              {k.items.map((i, n) => (
                <div key={n} className="cap-line">
                  <span>{i.quantity}×</span>
                  <span>
                    {i.itemName}
                    {i.variationName && <em> · {i.variationName}</em>}
                    {i.note && <small>“{i.note}”</small>}
                  </span>
                </div>
              ))}
            </section>
          ))}
          {order && (
            <div className="cap-total">
              <div><span>Subtotal</span><span>{rupee(order.subtotal)}</span></div>
              <div><span>GST</span><span>{rupee(order.taxAmount)}</span></div>
              <div className="grand"><span>Total</span><span>{rupee(order.total)}</span></div>
              <button className="btn-primary" disabled={busy} onClick={requestBill}>
                Request bill
              </button>
            </div>
          )}
        </div>
      )}

      {cart.length > 0 && (
        <div className="cap-cart">
          <ul>
            {cart.map((l) => (
              <li key={l.key}>
                <span className="cap-step">
                  <button onClick={() => changeQty(l.key, -1)} aria-label="One less">–</button>
                  <b>{l.quantity}</b>
                  <button onClick={() => changeQty(l.key, 1)} aria-label="One more">+</button>
                </span>
                <span className="cap-cname">
                  {l.name}
                  {l.detail && <small>{l.detail}</small>}
                </span>
                <span>{rupee(l.unitPrice * l.quantity)}</span>
              </li>
            ))}
          </ul>
          <button className="btn-primary cap-send" disabled={busy} onClick={sendKot}>
            {busy ? "Sending…" : `Send KOT · ${cartCount} item${cartCount > 1 ? "s" : ""} · ${rupee(cartTotal)}`}
          </button>
        </div>
      )}

      {dialogItem && (
        <ItemDialog
          item={dialogItem}
          onClose={() => setDialogItem(null)}
          onAdd={(line) => {
            addItem(dialogItem, line);
            setDialogItem(null);
          }}
        />
      )}
      {dialogCombo && (
        <ComboDialog
          combo={dialogCombo}
          onClose={() => setDialogCombo(null)}
          onAdd={(line) => {
            addCombo(dialogCombo, line);
            setDialogCombo(null);
          }}
        />
      )}
    </div>
  );
}
