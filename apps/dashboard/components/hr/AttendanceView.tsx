"use client";

import { useCallback, useEffect, useState } from "react";
import type { AttendanceRecordDto, AttendanceRegisterDto, DailyAttendanceDto, DayStatus } from "@stello/shared";
import { daysInMonth } from "@stello/shared";
import { hm, hrApi, timeIst, todayIst } from "@/lib/hr-api";

const STATUS_LABEL: Record<DayStatus, string> = {
  PRESENT: "Present",
  HALF_DAY: "Half day",
  ABSENT: "Absent",
  OFF: "Off",
  OPEN: "On shift",
  LEAVE: "Leave",
};
const STATUS_TONE: Record<DayStatus, string> = { PRESENT: "good", HALF_DAY: "info", ABSENT: "bad", OFF: "muted", OPEN: "info", LEAVE: "muted" };
const CELL: Record<DayStatus, string> = { PRESENT: "P", HALF_DAY: "½", ABSENT: "A", OFF: "·", OPEN: "•", LEAVE: "L" };

/** ISO instant → value for <input type="datetime-local"> in the browser's zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function AttendanceView({ outletId }: { outletId: string }) {
  const [mode, setMode] = useState<"daily" | "register">("daily");
  const [date, setDate] = useState(todayIst());
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const [daily, setDaily] = useState<DailyAttendanceDto | null>(null);
  const [register, setRegister] = useState<AttendanceRegisterDto | null>(null);
  const [correction, setCorrection] = useState<{ staffId: string; name: string; record: AttendanceRecordDto | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      if (mode === "daily") setDaily(await hrApi.daily(outletId, date));
      else {
        const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
        const to = last > todayIst() && month === todayIst().slice(0, 7) ? todayIst() : last;
        setRegister(await hrApi.register(outletId, `${month}-01`, to));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load attendance");
    }
  }, [outletId, mode, date, month]);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <div className="hr-subnav">
        <div className="range-tabs">
          <button className={`range-tab ${mode === "daily" ? "active" : ""}`} onClick={() => setMode("daily")}>Daily</button>
          <button className={`range-tab ${mode === "register" ? "active" : ""}`} onClick={() => setMode("register")}>Monthly register</button>
        </div>
        {mode === "daily" ? (
          <input type="date" value={date} max={todayIst()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        ) : (
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        )}
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      {mode === "daily" && daily && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Staff</th>
              <th>Shift</th>
              <th>Punches</th>
              <th className="num">Worked</th>
              <th className="num">Late</th>
              <th className="num">Overtime</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {daily.rows.map((r) => (
              <tr key={r.staffId}>
                <td className="strong">
                  {r.name}
                  {r.designation && <span className="faint"> · {r.designation}</span>}
                </td>
                <td className="mono faint">{r.shift ? `${r.shift.startTime}–${r.shift.endTime}` : "Off"}</td>
                <td>
                  {r.records.map((rec) => (
                    <button
                      key={rec.id}
                      className="text-btn"
                      title={rec.correctionReason ?? "Edit punch"}
                      onClick={() => setCorrection({ staffId: r.staffId, name: r.name, record: rec })}
                    >
                      {timeIst(rec.clockIn)}–{rec.clockOut ? timeIst(rec.clockOut) : "…"}
                      {rec.breakMinutes > 0 && ` (${rec.breakMinutes}m break)`}
                      {rec.source !== "PIN" && " ✎"}
                    </button>
                  ))}
                  {r.records.length === 0 && <span className="faint">—</span>}
                </td>
                <td className="num mono">{r.day.workedMinutes ? hm(r.day.workedMinutes) : "—"}</td>
                <td className="num mono">{r.day.lateMinutes ? `${r.day.lateMinutes}m` : "—"}</td>
                <td className="num mono">{r.day.overtimeMinutes ? hm(r.day.overtimeMinutes) : "—"}</td>
                <td><span className={`status-pill ${STATUS_TONE[r.day.status]}`}>{STATUS_LABEL[r.day.status]}</span></td>
                <td className="row-actions">
                  <button className="text-btn" onClick={() => setCorrection({ staffId: r.staffId, name: r.name, record: null })}>+ Punch</button>
                </td>
              </tr>
            ))}
            {daily.rows.length === 0 && <tr><td colSpan={8} className="empty">No active staff at this outlet.</td></tr>}
          </tbody>
        </table>
      )}

      {mode === "register" && register && (
        <>
          <div className="reg-legend">
            {(["PRESENT", "HALF_DAY", "ABSENT", "LEAVE", "OFF", "OPEN"] as DayStatus[]).map((s) => (
              <span key={s}><span className={`reg-cell ${s}`}>{CELL[s]}</span>{STATUS_LABEL[s]}</span>
            ))}
          </div>
          <div className="hr-scroll">
            <table className="data-table reg-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  {register.rows[0]?.days.map((d) => <th key={d.date}>{Number(d.date.slice(8))}</th>)}
                  <th>Present</th>
                  <th>Paid lv</th>
                  <th>LOP</th>
                  <th>Late</th>
                  <th>OT</th>
                </tr>
              </thead>
              <tbody>
                {register.rows.map((r) => (
                  <tr key={r.staffId}>
                    <td className="strong">{r.name}</td>
                    {r.days.map((d) => (
                      <td key={d.date}>
                        <span
                          className={`reg-cell ${d.status}`}
                          title={`${d.date}: ${STATUS_LABEL[d.status]}${d.leaveType ? ` (${d.leaveType.toLowerCase()})` : ""}${d.workedMinutes ? ` · ${hm(d.workedMinutes)}` : ""}${d.lateMinutes ? ` · late ${d.lateMinutes}m` : ""}`}
                        >
                          {CELL[d.status]}
                        </span>
                      </td>
                    ))}
                    <td className="mono">{r.totals.presentDays}</td>
                    <td className="mono">{r.totals.paidLeaveDays}</td>
                    <td className="mono">{r.totals.lopDays}</td>
                    <td className="mono">{r.totals.lateDays}</td>
                    <td className="mono">{hm(r.totals.overtimeMinutes)}</td>
                  </tr>
                ))}
                {register.rows.length === 0 && <tr><td colSpan={8} className="empty">No staff.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {correction && (
        <CorrectionDialog
          outletId={outletId}
          {...correction}
          defaultDate={date}
          onClose={() => setCorrection(null)}
          onSaved={() => {
            setCorrection(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function CorrectionDialog({
  outletId,
  staffId,
  name,
  record,
  defaultDate,
  onClose,
  onSaved,
}: {
  outletId: string;
  staffId: string;
  name: string;
  record: AttendanceRecordDto | null;
  defaultDate: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [clockIn, setClockIn] = useState(record ? toLocalInput(record.clockIn) : `${defaultDate}T09:00`);
  const [clockOut, setClockOut] = useState(record ? toLocalInput(record.clockOut) : `${defaultDate}T18:00`);
  const [breakMinutes, setBreak] = useState(record?.breakMinutes ?? 0);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await hrApi.correct(outletId, {
        staffId,
        recordId: record?.id ?? null,
        clockIn: new Date(clockIn).toISOString(),
        clockOut: clockOut ? new Date(clockOut).toISOString() : null,
        breakMinutes,
        reason: reason.trim(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <header className="modal-head">
          <h2>{record ? "Correct punch" : "Add punch"} · {name}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          {record?.correctionReason && <p className="hr-note">Previous note: {record.correctionReason}</p>}
          <div className="field-row">
            <label className="field">Clock in<input type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} /></label>
            <label className="field">Clock out<input type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} /></label>
          </div>
          <label className="field short">Break (min)<input type="number" min={0} value={breakMinutes} onChange={(e) => setBreak(Number(e.target.value) || 0)} /></label>
          <label className="field">Reason (required, audited)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Forgot to clock out" /></label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary grow" onClick={save} disabled={busy || reason.trim().length < 3 || !clockIn}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
