"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FloorAreaDto, FloorTableDto, FloorTableStatus, FloorViewDto } from "@stello/shared";
import { fohApi } from "@/lib/foh-api";
import { useOutletSocket } from "./useOutletSocket";
import { CALL_ICON } from "./ServerCallAlerts";
import "./foh.css";

export const STATUS_LABEL: Record<FloorTableStatus, string> = {
  FREE: "Free",
  OCCUPIED: "Occupied",
  BILL_PRINTED: "Bill printed",
  RESERVED: "Reserved",
};

const rupee = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function elapsed(since: string | null, now: number): string {
  if (!since) return "";
  const mins = Math.max(0, Math.floor((now - Date.parse(since)) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

/** One table drawn on the plan (shared by the live floor and the editor). */
export function TableShapeView({
  table,
  area,
  now,
  selected,
  mine,
  onClick,
  children,
  style,
  onPointerDown,
}: {
  table: { name: string; seats: number; placement: NonNullable<FloorTableDto["placement"]> } & Partial<FloorTableDto>;
  area: { width: number; height: number };
  now?: number;
  selected?: boolean;
  mine?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const p = table.placement;
  const status = table.status ?? "FREE";
  return (
    <button
      type="button"
      className={`fp-table shape-${p.shape.toLowerCase()} st-${status.toLowerCase()} ${selected ? "selected" : ""} ${mine ? "mine" : ""}`}
      style={{
        left: `${(p.x / area.width) * 100}%`,
        top: `${(p.y / area.height) * 100}%`,
        width: `${(p.width / area.width) * 100}%`,
        height: `${(p.height / area.height) * 100}%`,
        ...style,
      }}
      onClick={onClick}
      onPointerDown={onPointerDown}
      aria-label={`${table.name}, ${STATUS_LABEL[status]}`}
    >
      <span className="fp-body" style={{ transform: `rotate(${p.rotation}deg)` }} />
      <span className="fp-label">
        <strong>{table.name}</strong>
        {table.status && table.status !== "FREE" && now !== undefined ? (
          <>
            {table.since && <em>{elapsed(table.since, now)}</em>}
            {table.orderTotal != null && <em>{rupee(table.orderTotal)}</em>}
            {table.status === "RESERVED" && table.reservation && <em>{clock(table.reservation.startAt)}</em>}
          </>
        ) : (
          <em>{table.seats} seats</em>
        )}
      </span>
      {table.openCalls && table.openCalls.length > 0 && (
        <span className="fp-calls" aria-label="Open calls">{table.openCalls.map((c) => CALL_ICON[c]).join("")}</span>
      )}
      {children}
    </button>
  );
}

/**
 * Live floor: per-area visual plan with occupancy (free / occupied / bill
 * printed / reserved), running time and amount. Realtime via the outlet room,
 * with a slow poll as a safety net.
 */
export function LiveFloor({
  outletId,
  userId,
  onOpenOrder,
  onStartTable,
  canRequestBill = true,
  compact = false,
}: {
  outletId: string;
  userId?: string;
  onOpenOrder: (orderId: string, table: FloorTableDto) => void;
  onStartTable: (table: FloorTableDto) => void;
  canRequestBill?: boolean;
  compact?: boolean;
}) {
  const [view, setView] = useState<FloorViewDto | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [picked, setPicked] = useState<FloorTableDto | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await fohApi.floor(outletId);
      setView(v);
      setAreaId((cur) => (cur && v.areas.some((a) => a.id === cur) ? cur : (v.areas[0]?.id ?? null)));
      setPicked((cur) => (cur ? (v.areas.flatMap((a) => a.tables).find((t) => t.id === cur.id) ?? null) : null));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the floor");
    }
  }, [outletId]);

  useEffect(() => {
    void load();
    const poll = setInterval(load, 20000);
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const connected = useOutletSocket(outletId, { onChange: () => void load(), onCall: () => void load() });

  const myTableIds = useMemo(() => {
    if (!view || !userId) return new Set<string>();
    return new Set(view.areas.flatMap((a) => a.tables).filter((t) => t.waiterIds.includes(userId)).map((t) => t.id));
  }, [view, userId]);

  if (!view) return <div className="floor-empty">{error ?? "Loading floor…"}</div>;
  if (view.areas.length === 0) {
    return <div className="floor-empty">No areas yet. Set up the floor plan in Console → Floor plan.</div>;
  }
  const area = view.areas.find((a) => a.id === areaId) ?? view.areas[0];
  const all = view.areas.flatMap((a) => a.tables);
  const counts = (["FREE", "OCCUPIED", "BILL_PRINTED", "RESERVED"] as FloorTableStatus[]).map((s) => ({
    s,
    n: all.filter((t) => t.status === s).length,
  }));

  const filterMine = (tables: FloorTableDto[]) => (onlyMine ? tables.filter((t) => myTableIds.has(t.id)) : tables);
  const placed = filterMine(area.tables.filter((t) => t.placement));
  const unplaced = filterMine(area.tables.filter((t) => !t.placement));

  const requestBill = async (t: FloorTableDto) => {
    setBusy(true);
    try {
      await fohApi.requestBill(outletId, t.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request the bill");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`live-floor ${compact ? "compact" : ""}`}>
      <div className="lf-head">
        <div className="lf-areas" role="tablist">
          {view.areas.map((a) => (
            <button
              key={a.id}
              role="tab"
              aria-selected={a.id === area.id}
              className={`lf-area ${a.id === area.id ? "active" : ""}`}
              onClick={() => setAreaId(a.id)}
            >
              {a.name}
              <span>{a.tables.filter((t) => t.status !== "FREE").length}/{a.tables.length}</span>
            </button>
          ))}
        </div>
        <div className="lf-legend">
          {counts.map(({ s, n }) => (
            <span key={s} className={`lf-key st-${s.toLowerCase()}`}>
              <i /> {STATUS_LABEL[s]} {n}
            </span>
          ))}
          {userId && (
            <label className="lf-mine">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> My section
            </label>
          )}
          <span className={`lf-live ${connected ? "on" : ""}`}>{connected ? "Live" : "Polling"}</span>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}

      {placed.length > 0 && !compact && (
        <div className="fp-canvas live" style={{ aspectRatio: `${area.width} / ${area.height}` }}>
          {placed.map((t) => (
            <TableShapeView
              key={t.id}
              table={t as FloorTableDto & { placement: NonNullable<FloorTableDto["placement"]> }}
              area={area}
              now={now}
              selected={picked?.id === t.id}
              mine={myTableIds.has(t.id)}
              onClick={() => setPicked(t)}
            />
          ))}
        </div>
      )}

      {(compact ? [...placed, ...unplaced] : unplaced).length > 0 && (
        <div className="lf-grid">
          {!compact && <span className="lf-grid-label">Not on the plan</span>}
          {(compact ? [...placed, ...unplaced] : unplaced).map((t) => (
            <button
              key={t.id}
              className={`lf-tile st-${t.status.toLowerCase()} ${picked?.id === t.id ? "selected" : ""} ${myTableIds.has(t.id) ? "mine" : ""}`}
              onClick={() => setPicked(t)}
            >
              <strong>{t.name}</strong>
              <span>{STATUS_LABEL[t.status]}</span>
              <em>
                {t.orderTotal != null ? rupee(t.orderTotal) : `${t.seats} seats`}
                {t.since ? ` · ${elapsed(t.since, now)}` : ""}
              </em>
              {t.openCalls.length > 0 && <span className="fp-calls">{t.openCalls.map((c) => CALL_ICON[c]).join("")}</span>}
            </button>
          ))}
        </div>
      )}

      {picked && (
        <TableSheet
          table={picked}
          area={area}
          now={now}
          busy={busy}
          canRequestBill={canRequestBill}
          onClose={() => setPicked(null)}
          onOpen={() => (picked.orderId ? onOpenOrder(picked.orderId, picked) : onStartTable(picked))}
          onRequestBill={() => requestBill(picked)}
        />
      )}
    </div>
  );
}

function TableSheet({
  table,
  area,
  now,
  busy,
  canRequestBill,
  onClose,
  onOpen,
  onRequestBill,
}: {
  table: FloorTableDto;
  area: FloorAreaDto;
  now: number;
  busy: boolean;
  canRequestBill: boolean;
  onClose: () => void;
  onOpen: () => void;
  onRequestBill: () => void;
}) {
  return (
    <div className="lf-sheet" role="dialog" aria-label={`Table ${table.name}`}>
      <div className="lf-sheet-head">
        <div>
          <h3>
            {table.name} <small>{area.name}</small>
          </h3>
          <span className={`lf-status st-${table.status.toLowerCase()}`}>{STATUS_LABEL[table.status]}</span>
        </div>
        <button className="modal-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <dl className="lf-facts">
        <div>
          <dt>Seats</dt>
          <dd>{table.seats}</dd>
        </div>
        {table.since && (
          <div>
            <dt>Running</dt>
            <dd>{elapsed(table.since, now)}</dd>
          </div>
        )}
        {table.orderTotal != null && (
          <div>
            <dt>Bill</dt>
            <dd>{rupee(table.orderTotal)}</dd>
          </div>
        )}
        {table.reservation && (
          <div className="wide">
            <dt>{table.reservation.status === "SEATED" ? "Seated" : "Reservation"}</dt>
            <dd>
              {table.reservation.guestName} · {table.reservation.partySize} pax · {clock(table.reservation.startAt)}
            </dd>
          </div>
        )}
        {table.waiterNames.length > 0 && (
          <div className="wide">
            <dt>Section</dt>
            <dd>{table.waiterNames.join(", ")}</dd>
          </div>
        )}
        {table.openCalls.length > 0 && (
          <div className="wide">
            <dt>Calls</dt>
            <dd>{table.openCalls.map((c) => `${CALL_ICON[c]} ${c.toLowerCase()}`).join("  ")}</dd>
          </div>
        )}
      </dl>
      <div className="lf-sheet-actions">
        <button className="btn-primary" onClick={onOpen} disabled={busy}>
          {table.orderId ? "Open order" : "Start order"}
        </button>
        {table.orderId && canRequestBill && table.status !== "BILL_PRINTED" && (
          <button className="btn-ghost" onClick={onRequestBill} disabled={busy}>
            Request bill
          </button>
        )}
      </div>
    </div>
  );
}
