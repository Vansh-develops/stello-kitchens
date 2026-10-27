"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FloorTableDto,
  FloorViewDto,
  ReservationDto,
  ReservationSource,
  ReservationStatus,
  WaitlistEntryDto,
} from "@stello/shared";
import { BLOCKING_RESERVATION_STATUSES, RESERVATION_TRANSITIONS, intervalsOverlap } from "@stello/shared";
import { fohApi } from "@/lib/foh-api";
import { useOutletSocket } from "./useOutletSocket";
import "./foh.css";

export type SeatedGuest = { tableId: string; guestName: string; phone: string | null };

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
const STATUS_TEXT: Record<ReservationStatus, string> = {
  BOOKED: "Booked",
  CONFIRMED: "Confirmed",
  SEATED: "Seated",
  NO_SHOW: "No-show",
  CANCELLED: "Cancelled",
};
const SOURCES: ReservationSource[] = ["PHONE", "WALK_IN", "WEB", "AGGREGATOR", "OTHER"];

/**
 * Reservations day view (timeline per table + list) and the walk-in waitlist.
 * Seating hands the table back to the host screen via `onSeated` so the POS /
 * captain can open it with the guest prefilled.
 */
export function ReservationsBoard({ outletId, onSeated }: { outletId: string; onSeated?: (g: SeatedGuest) => void }) {
  const [day, setDay] = useState(localDate(new Date()));
  const [list, setList] = useState<ReservationDto[]>([]);
  const [floor, setFloor] = useState<FloorViewDto | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistEntryDto[]>([]);
  const [editing, setEditing] = useState<ReservationDto | "new" | null>(null);
  const [seating, setSeating] = useState<{ kind: "reservation"; r: ReservationDto } | { kind: "waitlist"; w: WaitlistEntryDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const from = new Date(`${day}T00:00:00`);
    const to = new Date(from.getTime() + 86400_000);
    try {
      const [r, f, w] = await Promise.all([
        fohApi.reservations(outletId, from.toISOString(), to.toISOString()),
        fohApi.floor(outletId),
        fohApi.waitlist(outletId),
      ]);
      setList(r);
      setFloor(f);
      setWaitlist(w);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reservations");
    }
  }, [outletId, day]);

  useEffect(() => {
    void load();
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [load]);
  useOutletSocket(outletId, { onChange: () => void load() });

  const tables = useMemo(() => floor?.areas.flatMap((a) => a.tables.map((t) => ({ ...t, areaName: a.name }))) ?? [], [floor]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  };

  const seat = async (tableId: string) => {
    if (!seating) return;
    try {
      if (seating.kind === "reservation") {
        const res = await fohApi.seatReservation(outletId, seating.r.id, tableId);
        onSeated?.({ tableId: res.tableId, guestName: seating.r.guestName, phone: seating.r.phone });
      } else {
        const res = await fohApi.seatWaitlist(outletId, seating.w.id, tableId);
        onSeated?.({ tableId: res.tableId, guestName: seating.w.guestName, phone: seating.w.phone });
      }
      setSeating(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not seat");
    }
  };

  // Timeline spans service hours, widened to fit any booking on the day.
  const dayStart = new Date(`${day}T00:00:00`).getTime();
  const hours = list.map((r) => (Date.parse(r.startAt) - dayStart) / 3600_000);
  const fromH = Math.max(0, Math.min(11, ...hours.map(Math.floor)));
  const toH = Math.min(24, Math.max(24, ...list.map((r, i) => Math.ceil(hours[i] + r.durationMinutes / 60))));
  const span = toH - fromH;
  const pct = (ms: number) => ((ms - dayStart) / 3600_000 - fromH) / span * 100;
  const nowPct = pct(now);

  return (
    <div className="foh-pane">
      <div className="foh-row between">
        <h1>Reservations</h1>
        <div className="foh-row">
          <button className="foh-btn" onClick={() => setDay(localDate(new Date(new Date(`${day}T12:00:00`).getTime() - 86400_000)))} aria-label="Previous day">‹</button>
          <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button className="foh-btn" onClick={() => setDay(localDate(new Date(new Date(`${day}T12:00:00`).getTime() + 86400_000)))} aria-label="Next day">›</button>
          <button className="foh-btn" onClick={() => setDay(localDate(new Date()))}>Today</button>
          <button className="btn-primary sm" onClick={() => setEditing("new")}>+ Reservation</button>
        </div>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="rsv">
        <div className="foh-form">
          <div className="rsv-timeline">
            <div className="rsv-grid" style={{ ["--hour" as string]: `${100 / span}%` }}>
              <div className="rsv-hours">
                <div />
                <div>
                  {Array.from({ length: span + 1 }, (_, i) => fromH + i).map((h) => (
                    <span key={h} className="rsv-hour" style={{ left: `${((h - fromH) / span) * 100}%` }}>
                      {h === 24 ? "00" : pad(h)}:00
                    </span>
                  ))}
                </div>
              </div>
              {tables.map((t) => (
                <div key={t.id} className="rsv-line">
                  <div className="rsv-tname">
                    {t.name} <small className="foh-muted">· {t.seats}</small>
                  </div>
                  <div className="rsv-track">
                    {nowPct >= 0 && nowPct <= 100 && <span className="rsv-now" style={{ left: `${nowPct}%` }} />}
                    {list
                      .filter((r) => r.tables.some((x) => x.id === t.id))
                      .map((r) => {
                        const s = Date.parse(r.startAt);
                        return (
                          <button
                            key={r.id}
                            className={`rsv-block s-${r.status.toLowerCase()}`}
                            style={{ left: `${pct(s)}%`, width: `${(r.durationMinutes / 60 / span) * 100}%` }}
                            title={`${r.guestName} · ${r.partySize} pax · ${clock(r.startAt)}`}
                            onClick={() => setEditing(r)}
                          >
                            {clock(r.startAt)} {r.guestName} ({r.partySize})
                          </button>
                        );
                      })}
                  </div>
                </div>
              ))}
              {tables.length === 0 && <p className="foh-muted" style={{ padding: 16 }}>No tables yet — add them in Console → Floor plan.</p>}
            </div>
          </div>

          <div className="rsv-list">
            {list.length === 0 && <p className="foh-muted">No reservations on this day.</p>}
            {list.map((r) => {
              const next = RESERVATION_TRANSITIONS[r.status];
              return (
                <div key={r.id} className="rsv-item">
                  <span className="rsv-time">{clock(r.startAt)}</span>
                  <div className="rsv-who">
                    <strong>
                      {r.guestName} · {r.partySize} pax <span className={`rsv-badge s-${r.status.toLowerCase()}`}>{STATUS_TEXT[r.status]}</span>
                    </strong>
                    <small>
                      {r.phone} · {r.tables.map((t) => t.name).join(", ") || "no table"} · {r.durationMinutes}m · {r.source.toLowerCase().replace("_", "-")}
                      {r.notes ? ` · “${r.notes}”` : ""}
                    </small>
                    {r.customer && (
                      <div className="rsv-crm">
                        Regular: {r.customer.totalOrders} visits{r.customer.lastVisitAt ? `, last ${new Date(r.customer.lastVisitAt).toLocaleDateString("en-IN")}` : ""}
                      </div>
                    )}
                  </div>
                  <div className="rsv-actions">
                    {next.includes("CONFIRMED") && (
                      <button className="foh-btn" onClick={() => run(() => fohApi.reservationStatus(outletId, r.id, "CONFIRMED"))}>Confirm</button>
                    )}
                    {next.includes("SEATED") && (
                      <button className="foh-btn primary" onClick={() => setSeating({ kind: "reservation", r })}>Seat</button>
                    )}
                    {next.includes("NO_SHOW") && (
                      <button className="foh-btn" onClick={() => run(() => fohApi.reservationStatus(outletId, r.id, "NO_SHOW"))}>No-show</button>
                    )}
                    {next.includes("CANCELLED") && (
                      <button className="foh-btn danger" onClick={() => confirm(`Cancel ${r.guestName}'s reservation?`) && run(() => fohApi.reservationStatus(outletId, r.id, "CANCELLED"))}>Cancel</button>
                    )}
                    {(r.status === "CANCELLED" || r.status === "NO_SHOW") && (
                      <button className="foh-btn" onClick={() => run(() => fohApi.reservationStatus(outletId, r.id, "BOOKED"))}>Reinstate</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Waitlist outletId={outletId} entries={waitlist} now={now} onSeat={(w) => setSeating({ kind: "waitlist", w })} onRun={run} />
      </div>

      {editing && (
        <ReservationDialog
          outletId={outletId}
          day={day}
          existing={editing === "new" ? null : editing}
          tables={tables}
          dayList={list}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {seating && (
        <SeatPicker
          title={seating.kind === "reservation" ? `Seat ${seating.r.guestName} (${seating.r.partySize})` : `Seat ${seating.w.guestName} (${seating.w.partySize})`}
          tables={tables}
          suggested={seating.kind === "reservation" ? seating.r.tables.map((t) => t.id) : []}
          partySize={seating.kind === "reservation" ? seating.r.partySize : seating.w.partySize}
          onPick={seat}
          onClose={() => setSeating(null)}
        />
      )}
    </div>
  );
}

function Waitlist({
  outletId,
  entries,
  now,
  onSeat,
  onRun,
}: {
  outletId: string;
  entries: WaitlistEntryDto[];
  now: number;
  onSeat: (w: WaitlistEntryDto) => void;
  onRun: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({ guestName: "", phone: "", partySize: 2, quotedMinutes: 15 });
  const waiting = entries.filter((w) => w.status === "WAITING" || w.status === "NOTIFIED");
  const add = () =>
    onRun(async () => {
      await fohApi.addWaitlist(outletId, {
        guestName: form.guestName.trim(),
        phone: form.phone.trim() || undefined,
        partySize: form.partySize,
        quotedMinutes: form.quotedMinutes,
      });
      setForm({ guestName: "", phone: "", partySize: 2, quotedMinutes: 15 });
    });

  return (
    <aside className="foh-card foh-form">
      <div className="foh-row between">
        <strong>Waitlist</strong>
        <span className="foh-muted">{waiting.length} waiting</span>
      </div>
      <div className="foh-form">
        <input placeholder="Guest name" value={form.guestName} onChange={(e) => setForm({ ...form, guestName: e.target.value })} />
        <input placeholder="Phone (to text when ready)" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <div className="fpe-grid2">
          <label className="field">
            <span>Party</span>
            <input type="number" min={1} value={form.partySize} onChange={(e) => setForm({ ...form, partySize: Math.max(1, Number(e.target.value)) })} />
          </label>
          <label className="field">
            <span>Quote (min)</span>
            <input type="number" min={0} step={5} value={form.quotedMinutes} onChange={(e) => setForm({ ...form, quotedMinutes: Math.max(0, Number(e.target.value)) })} />
          </label>
        </div>
        <button className="btn-primary sm" disabled={!form.guestName.trim()} onClick={add}>Add walk-in</button>
      </div>
      {waiting.map((w) => {
        const waited = Math.floor((now - Date.parse(w.createdAt)) / 60000);
        return (
          <div key={w.id} className="wl-item">
            <div className="foh-row between">
              <strong>{w.guestName} · {w.partySize}</strong>
              <span className={`wl-wait ${waited > w.quotedMinutes ? "late" : ""}`}>
                {waited}m / {w.quotedMinutes}m{w.status === "NOTIFIED" ? " · texted" : ""}
              </span>
            </div>
            <div className="foh-row">
              <button className="foh-btn primary" onClick={() => onSeat(w)}>Seat</button>
              {w.phone && <button className="foh-btn" onClick={() => onRun(() => fohApi.notifyWaitlist(outletId, w.id))}>Notify</button>}
              <button className="foh-btn danger" onClick={() => onRun(() => fohApi.leaveWaitlist(outletId, w.id))}>Left</button>
            </div>
          </div>
        );
      })}
    </aside>
  );
}

function SeatPicker({
  title,
  tables,
  suggested,
  partySize,
  onPick,
  onClose,
}: {
  title: string;
  tables: (FloorTableDto & { areaName: string })[];
  suggested: string[];
  partySize: number;
  onPick: (tableId: string) => void;
  onClose: () => void;
}) {
  const free = tables.filter((t) => t.status === "FREE" || t.status === "RESERVED" || suggested.includes(t.id));
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="foh-muted">Tables without a running order. Booked tables are listed first.</p>
          <div className="table-checks">
            {[...free.filter((t) => suggested.includes(t.id)), ...free.filter((t) => !suggested.includes(t.id))].map((t) => (
              <button key={t.id} className={suggested.includes(t.id) ? "on" : ""} onClick={() => onPick(t.id)} title={t.areaName}>
                {t.name} · {t.seats}
                {t.seats < partySize ? " ⚠" : ""}
              </button>
            ))}
          </div>
          {free.length === 0 && <p className="form-error">Every table is occupied right now.</p>}
        </div>
      </div>
    </div>
  );
}

function ReservationDialog({
  outletId,
  day,
  existing,
  tables,
  dayList,
  onClose,
  onSaved,
}: {
  outletId: string;
  day: string;
  existing: ReservationDto | null;
  tables: (FloorTableDto & { areaName: string })[];
  dayList: ReservationDto[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const start = existing ? new Date(existing.startAt) : null;
  const [form, setForm] = useState({
    guestName: existing?.guestName ?? "",
    phone: existing?.phone ?? "",
    partySize: existing?.partySize ?? 2,
    date: start ? localDate(start) : day,
    time: start ? `${pad(start.getHours())}:${pad(start.getMinutes())}` : "20:00",
    durationMinutes: existing?.durationMinutes ?? 90,
    tableIds: existing?.tables.map((t) => t.id) ?? [],
    notes: existing?.notes ?? "",
    source: existing?.source ?? ("PHONE" as ReservationSource),
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editable = !existing || existing.status === "BOOKED" || existing.status === "CONFIRMED";

  const startMs = new Date(`${form.date}T${form.time}:00`).getTime();
  // Client-side hint only; the API is the authority (it locks + re-checks).
  const busy = new Set(
    dayList
      .filter((r) => r.id !== existing?.id && BLOCKING_RESERVATION_STATUSES.includes(r.status))
      .filter((r) => intervalsOverlap(startMs, form.durationMinutes, Date.parse(r.startAt), r.durationMinutes))
      .flatMap((r) => r.tables.map((t) => t.id)),
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    const input = {
      guestName: form.guestName.trim(),
      phone: form.phone.trim(),
      partySize: form.partySize,
      startAt: new Date(startMs).toISOString(),
      durationMinutes: form.durationMinutes,
      tableIds: form.tableIds,
      notes: form.notes.trim() || undefined,
      source: form.source,
    };
    try {
      if (existing) await fohApi.updateReservation(outletId, existing.id, input);
      else await fohApi.createReservation(outletId, input);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{existing ? `Reservation · ${existing.guestName}` : "New reservation"}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {!editable && <p className="foh-muted">This reservation is {existing?.status.toLowerCase()} and can no longer be edited.</p>}
          <div className="field-row">
            <label className="field">
              <span>Guest name</span>
              <input value={form.guestName} onChange={(e) => set("guestName", e.target.value)} disabled={!editable} />
            </label>
            <label className="field">
              <span>Phone</span>
              <input value={form.phone} inputMode="tel" onChange={(e) => set("phone", e.target.value)} disabled={!editable} />
            </label>
          </div>
          <div className="field-row">
            <label className="field short">
              <span>Party</span>
              <input type="number" min={1} value={form.partySize} onChange={(e) => set("partySize", Math.max(1, Number(e.target.value)))} disabled={!editable} />
            </label>
            <label className="field">
              <span>Date</span>
              <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} disabled={!editable} />
            </label>
            <label className="field">
              <span>Time</span>
              <input type="time" step={900} value={form.time} onChange={(e) => set("time", e.target.value)} disabled={!editable} />
            </label>
            <label className="field short">
              <span>Minutes</span>
              <input type="number" min={15} max={480} step={15} value={form.durationMinutes} onChange={(e) => set("durationMinutes", Number(e.target.value))} disabled={!editable} />
            </label>
          </div>
          <label className="field">
            <span>Tables {form.tableIds.length > 0 && `(${tables.filter((t) => form.tableIds.includes(t.id)).reduce((s, t) => s + t.seats, 0)} seats)`}</span>
            <div className="table-checks">
              {tables.map((t) => {
                const on = form.tableIds.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={!editable}
                    className={`${on ? "on" : ""} ${busy.has(t.id) ? "busy" : ""}`}
                    title={busy.has(t.id) ? "Already reserved in this window" : t.areaName}
                    onClick={() => set("tableIds", on ? form.tableIds.filter((x) => x !== t.id) : [...form.tableIds, t.id])}
                  >
                    {t.name} · {t.seats}
                  </button>
                );
              })}
            </div>
          </label>
          <div className="field-row">
            <label className="field">
              <span>Source</span>
              <select value={form.source} onChange={(e) => set("source", e.target.value as ReservationSource)} disabled={!editable}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>{s.replace("_", "-").toLowerCase()}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field foh-form">
            <span>Notes</span>
            <textarea value={form.notes} maxLength={500} onChange={(e) => set("notes", e.target.value)} disabled={!editable} />
          </label>
          {existing?.customer && (
            <p className="rsv-crm">Linked CRM customer: {existing.customer.name ?? existing.phone} · {existing.customer.totalOrders} visits</p>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          {editable && (
            <button className="btn-primary" disabled={saving || !form.guestName.trim() || !form.phone.trim()} onClick={save}>
              {saving ? "Saving…" : existing ? "Save changes" : "Book table"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
