import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { KdsStockItemDto, KdsTicketDto, OutletDto, PrepStatus, StationDto } from "@stello/shared";
import { api } from "./api";

const NEXT: Record<PrepStatus, PrepStatus> = {
  PENDING: "PREPARING",
  PREPARING: "READY",
  READY: "PREPARING", // tap a ready ticket to recall it
};
const ADVANCE_LABEL: Record<PrepStatus, string> = {
  PENDING: "Start",
  PREPARING: "Bump ready",
  READY: "Recall",
};

function ageColor(elapsedMin: number, prepMinutes: number): "fresh" | "warm" | "late" {
  const ratio = elapsedMin / Math.max(prepMinutes, 1);
  if (ratio < 0.5) return "fresh";
  if (ratio < 1) return "warm";
  return "late";
}

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Board({ outlet, onExit }: { outlet: OutletDto; onExit: () => void }) {
  const [stations, setStations] = useState<StationDto[]>([]);
  const [tickets, setTickets] = useState<KdsTicketDto[]>([]);
  const [stock, setStock] = useState<KdsStockItemDto[]>([]);
  const [station, setStation] = useState<string>("all");
  const [cookList, setCookList] = useState(false);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [t, s] = await Promise.all([api.tickets(outlet.id), api.stock(outlet.id)]);
    setTickets(t);
    setStock(s);
  }, [outlet.id]);

  // Ticking clock for ageing (1s).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Initial load + station list.
  useEffect(() => {
    void api.stations(outlet.id).then(setStations);
    void refresh();
  }, [outlet.id, refresh]);

  // Real-time: join the outlet room, refetch on signal; poll as a fallback.
  useEffect(() => {
    const socket: Socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    const onChange = (msg: { outletId: string }) => {
      if (msg.outletId === outlet.id) void refresh();
    };
    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join", { outletId: outlet.id });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("kds:changed", onChange);

    const poll = setInterval(() => void refresh(), 8000);
    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, [outlet.id, refresh]);

  const advance = async (t: KdsTicketDto) => {
    setBusyKey(t.key);
    // Optimistic: move immediately, reconcile on refetch.
    const target = NEXT[t.status];
    setTickets((prev) =>
      prev.map((x) => (x.key === t.key ? { ...x, status: target } : x)),
    );
    try {
      await api.advance(t.kotId, { stationId: t.stationId, toStatus: target });
    } catch {
      await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const toggle86 = async (itemId: string, current: boolean) => {
    setStock((prev) => prev.map((s) => (s.itemId === itemId ? { ...s, inStock: !current } : s)));
    try {
      await api.toggleStock(outlet.id, itemId, !current);
    } catch {
      await refresh();
    }
  };

  const visible = useMemo(
    () => (station === "all" ? tickets : tickets.filter((t) => t.stationId === station)),
    [tickets, station],
  );

  const columns: { key: PrepStatus; label: string }[] = [
    { key: "PENDING", label: "New" },
    { key: "PREPARING", label: "Preparing" },
    { key: "READY", label: "Ready" },
  ];
  const byStatus = (s: PrepStatus) => visible.filter((t) => t.status === s);

  const stockMap = useMemo(() => new Map(stock.map((s) => [s.itemId, s])), [stock]);

  // Aggregated cook list: sum active (not-ready) item quantities for the view.
  const cookRows = useMemo(() => {
    const agg = new Map<string, { itemId: string; name: string; qty: number }>();
    for (const t of visible) {
      if (t.status === "READY") continue;
      for (const it of t.items) {
        const row = agg.get(it.itemId) ?? { itemId: it.itemId, name: it.name, qty: 0 };
        row.qty += it.quantity;
        agg.set(it.itemId, row);
      }
    }
    return [...agg.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  }, [visible]);

  const clock = new Date(now).toLocaleTimeString("en-IN", { hour12: false });

  return (
    <div className="kds">
      <header className="kds-head">
        <div className="kds-brand">
          <span className="wordmark">STELLO KITCHENS</span>
          <span className="kds-sub">KDS · {outlet.name.replace("Stello Kitchens - ", "")}</span>
        </div>

        <nav className="station-tabs">
          <button
            className={`st-tab ${station === "all" ? "active" : ""}`}
            onClick={() => setStation("all")}
          >
            All
            <span className="st-count">{tickets.filter((t) => t.status !== "READY").length}</span>
          </button>
          {stations.map((s) => {
            const count = tickets.filter((t) => t.stationId === s.id && t.status !== "READY").length;
            return (
              <button
                key={s.id}
                className={`st-tab ${station === s.id ? "active" : ""}`}
                onClick={() => setStation(s.id)}
              >
                {s.name}
                {count > 0 && <span className="st-count">{count}</span>}
              </button>
            );
          })}
        </nav>

        <div className="kds-meta">
          <button
            className={`cook-toggle ${cookList ? "on" : ""}`}
            onClick={() => setCookList((v) => !v)}
          >
            Cook list
          </button>
          <span className={`conn ${connected ? "live" : "down"}`}>
            {connected ? "LIVE" : "RECONNECTING"}
          </span>
          <span className="clock">{clock}</span>
          <button className="exit" onClick={onExit} title="Sign out">
            ✕
          </button>
        </div>
      </header>

      {cookList ? (
        <div className="cook-pane">
          <div className="cook-head">
            <h2>Cook list — {station === "all" ? "all stations" : stations.find((s) => s.id === station)?.name}</h2>
            <p>Quantities across all active tickets. Tap 86 to mark an item out of stock everywhere.</p>
          </div>
          <div className="cook-rows">
            {cookRows.length === 0 && <p className="empty">Nothing cooking right now.</p>}
            {cookRows.map((r) => {
              const inStock = stockMap.get(r.itemId)?.inStock ?? true;
              return (
                <div key={r.itemId} className={`cook-row ${!inStock ? "oos" : ""}`}>
                  <span className="cook-qty">{r.qty}</span>
                  <span className="cook-name">{r.name}</span>
                  <button
                    className={`btn-86 ${!inStock ? "active" : ""}`}
                    onClick={() => toggle86(r.itemId, inStock)}
                  >
                    {inStock ? "86" : "Restore"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="board">
          {columns.map((col) => (
            <section key={col.key} className={`lane lane-${col.key.toLowerCase()}`}>
              <div className="lane-head">
                <span className="lane-label">{col.label}</span>
                <span className="lane-count">{byStatus(col.key).length}</span>
              </div>
              <div className="lane-body">
                {byStatus(col.key).map((t) => {
                  const elapsedMs = now - new Date(t.createdAt).getTime();
                  const elapsedMin = elapsedMs / 60000;
                  const tone = t.status === "READY" ? "done" : ageColor(elapsedMin, t.prepMinutes);
                  return (
                    <button
                      key={t.key}
                      className={`ticket tone-${tone} ${busyKey === t.key ? "busy" : ""}`}
                      onClick={() => advance(t)}
                    >
                      <div className="ticket-top">
                        <span className="ticket-kot">KOT {t.kotNumber}</span>
                        <span className="ticket-age">{fmtElapsed(elapsedMs)}</span>
                      </div>
                      <div className="ticket-ctx">
                        <span className="ticket-where">
                          {t.tableName ?? t.orderType.replace("_", " ").toLowerCase()}
                        </span>
                        {station === "all" && <span className="ticket-station">{t.stationName}</span>}
                      </div>
                      <ul className="ticket-items">
                        {t.items.map((it) => (
                          <li key={it.id}>
                            <span className="ti-qty">{it.quantity}×</span>
                            <span className="ti-name">
                              {it.name}
                              {it.variationName && <em> · {it.variationName}</em>}
                              {it.addonNames.length > 0 && <small>+ {it.addonNames.join(", ")}</small>}
                              {it.note && <small className="ti-note">“{it.note}”</small>}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <span className="ticket-action">{ADVANCE_LABEL[t.status]}</span>
                    </button>
                  );
                })}
                {byStatus(col.key).length === 0 && <p className="lane-empty">—</p>}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
