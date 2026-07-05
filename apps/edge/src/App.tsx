import { useCallback, useEffect, useMemo, useState } from "react";
import type { MenuCategoryDto, MenuItemDto } from "@petpooja/shared";
import { edge, type EdgeStatus, type LocalOrderRow } from "./api";

const rupee = (n: number) => `₹${n.toFixed(2)}`;
type CartLine = { key: string; item: MenuItemDto; qty: number };

export function App() {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [menu, setMenu] = useState<MenuCategoryDto[]>([]);
  const [orders, setOrders] = useState<LocalOrderRow[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await edge.status();
      setStatus(s);
      if (s.outletId) {
        const [m, o] = await Promise.all([edge.menu(), edge.orders()]);
        setMenu(m);
        setOrders(o);
        setActiveCat((c) => c ?? m[0]?.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sidecar unreachable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const flashMsg = (m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 2500);
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await edge.bootstrap("cashier@demo.com", "password123");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setBusy(false);
    }
  };

  const addToCart = (item: MenuItemDto) =>
    setCart((prev) => {
      const found = prev.find((l) => l.item.id === item.id);
      if (found) return prev.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { key: item.id, item, qty: 1 }];
    });
  const changeQty = (key: string, d: number) =>
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));

  const cartTotal = useMemo(() => cart.reduce((s, l) => s + l.item.price * l.qty, 0), [cart]);

  const billAndSettle = async () => {
    if (cart.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const order = await edge.createOrder({
        orderType: "TAKEAWAY",
        items: cart.map((l) => ({ itemId: l.item.id, quantity: l.qty, addonIds: [] })),
      });
      const settled = await edge.settle(order.clientId, [{ mode: "CASH", amount: order.total }]);
      setCart([]);
      flashMsg(`Provisional ${settled.offlineRef} · ${rupee(settled.total)} — tax invoice on sync`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not settle");
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await edge.sync();
      flashMsg(`Synced ${r.pushed} order(s) to cloud`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed (offline?)");
    } finally {
      setBusy(false);
    }
  };

  const toggleOffline = async () => {
    if (!status) return;
    await edge.setOffline(!status.forcedOffline);
    await refresh();
  };

  if (!status) {
    return <div className="boot">{error ?? "Starting local master service…"}</div>;
  }

  if (!status.outletId) {
    return (
      <div className="connect">
        <div className="connect-card">
          <span className="wordmark">SPICE ROUTE · EDGE</span>
          <h1>Local terminal setup</h1>
          <p className="connect-hint">Device {status.deviceId}. Connect once to cache the menu, then this terminal bills offline.</p>
          {error && <p className="form-error">{error}</p>}
          <button className="btn-primary" onClick={connect} disabled={busy}>
            {busy ? "Connecting…" : "Connect & cache menu"}
          </button>
        </div>
      </div>
    );
  }

  const online = status.online && !status.forcedOffline;
  const activeItems = menu.find((c) => c.id === activeCat)?.items ?? [];

  return (
    <div className="edge">
      <header className="edge-head">
        <div className="eh-brand">
          <span className="wordmark">SPICE ROUTE</span>
          <span className="eh-sub">EDGE · {status.outletName?.replace("Spice Route - ", "")} · {status.deviceId}</span>
        </div>
        <div className="eh-status">
          <span className={`net ${online ? "online" : "offline"}`}>
            <span className="net-dot" /> {online ? "ONLINE" : "OFFLINE"}
          </span>
          <span className="outbox">Outbox <strong>{status.pending}</strong></span>
          <button className="eh-btn" onClick={syncNow} disabled={busy || !online}>Sync now</button>
          <button className="eh-btn ghost" onClick={toggleOffline}>
            {status.forcedOffline ? "Go online" : "Simulate offline"}
          </button>
        </div>
      </header>

      {flash && <div className="flash">{flash}</div>}
      {error && <div className="edge-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="edge-body">
        <nav className="edge-cats">
          {menu.map((c) => (
            <button key={c.id} className={`ecat ${c.id === activeCat ? "active" : ""}`} onClick={() => setActiveCat(c.id)}>
              {c.name}
            </button>
          ))}
        </nav>

        <main className="edge-grid">
          {activeItems.map((it) => (
            <button key={it.id} className="eitem" onClick={() => addToCart(it)}>
              <span className={`veg-dot ${it.isVeg ? "veg" : "nonveg"}`} />
              <span className="eitem-name">{it.name}</span>
              <span className="eitem-price">{rupee(it.price)}</span>
            </button>
          ))}
        </main>

        <section className="edge-bill">
          <div className="eb-lines">
            {cart.length === 0 && <p className="eb-empty">Tap items to bill. Works offline — sales queue in the outbox.</p>}
            {cart.map((l) => (
              <div key={l.key} className="eb-line">
                <span className="eb-step">
                  <button onClick={() => changeQty(l.key, -1)}>–</button>
                  <span>{l.qty}</span>
                  <button onClick={() => changeQty(l.key, +1)}>+</button>
                </span>
                <span className="eb-name">{l.item.name}</span>
                <span className="eb-amt">{rupee(l.item.price * l.qty)}</span>
              </div>
            ))}
          </div>
          <div className="eb-foot">
            <div className="eb-total"><span>Total</span><span>{rupee(cartTotal)}</span></div>
            <button className="btn-primary" onClick={billAndSettle} disabled={busy || cart.length === 0}>
              Settle (cash) · {rupee(cartTotal)}
            </button>
          </div>

          <div className="eb-recent">
            <span className="eb-recent-label">Local orders</span>
            {orders.slice(0, 6).map((o) => (
              <div key={o.clientId} className="eb-recent-row">
                <span className="mono">{o.billNumber ?? o.offlineRef ?? o.clientId.slice(0, 6)}</span>
                <span className="mono">{rupee(o.total)}</span>
                <span className={`sync-pill ${o.synced ? "synced" : "pending"}`}>{o.synced ? "synced" : "queued"}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
