"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RosterWeekDto, ShiftTemplateDto, ShiftTemplateInput, SwapRequestDto } from "@stello/shared";
import { addDays, weekdayOf } from "@stello/shared";
import { hrApi, todayIst } from "@/lib/hr-api";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));

export function RosterView({ outletId }: { outletId: string }) {
  const [weekStart, setWeekStart] = useState(mondayOf(todayIst()));
  const [week, setWeek] = useState<RosterWeekDto | null>(null);
  const [templates, setTemplates] = useState<ShiftTemplateDto[]>([]);
  const [swaps, setSwaps] = useState<SwapRequestDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tpl, setTpl] = useState<ShiftTemplateInput>({ name: "", startTime: "09:00", endTime: "17:00", breakMinutes: 30, graceMinutes: 10 });
  const [swap, setSwap] = useState({ fromShiftId: "", toStaffId: "", toShiftId: "" });

  const reload = useCallback(async () => {
    try {
      const [w, t, s] = await Promise.all([hrApi.roster(outletId, weekStart), hrApi.templates(outletId), hrApi.swaps(outletId)]);
      setWeek(w);
      setTemplates(t);
      setSwaps(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load roster");
    }
  }, [outletId, weekStart]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const cell = (staffId: string, date: string) => week?.shifts.find((s) => s.staffId === staffId && s.date === date) ?? null;
  const leave = (staffId: string, date: string) => week?.leaves.find((l) => l.staffId === staffId && l.date === date) ?? null;
  const nameOf = useMemo(() => new Map(week?.staff.map((s) => [s.id, s.name]) ?? []), [week]);
  const fromShift = week?.shifts.find((s) => s.id === swap.fromShiftId);

  return (
    <>
      <div className="hr-subnav">
        <button className="text-btn" onClick={() => setWeekStart(addDays(weekStart, -7))}>← Prev</button>
        <strong>Week of {new Date(`${weekStart}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</strong>
        <button className="text-btn" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</button>
        <button className="text-btn" onClick={() => setWeekStart(mondayOf(todayIst()))}>This week</button>
        <span style={{ flex: 1 }} />
        <button className="btn-ghost sm" onClick={() => void run(() => hrApi.copyRoster(outletId, addDays(weekStart, -7), weekStart))}>
          Copy previous week
        </button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="hr-grid-2">
        <div className="hr-scroll">
          <table className="data-table roster-table">
            <thead>
              <tr>
                <th>Staff</th>
                {week?.dates.map((d) => (
                  <th key={d}>{DOW[weekdayOf(d)]} {Number(d.slice(8))}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {week?.staff.map((s) => (
                <tr key={s.id}>
                  <td className="strong">
                    {s.name}
                    {s.designation && <div className="faint">{s.designation}</div>}
                  </td>
                  {week.dates.map((d) => {
                    const sh = cell(s.id, d);
                    const lv = leave(s.id, d);
                    return (
                      <td key={d}>
                        <select
                          value={sh?.templateId ?? (sh ? "custom" : "")}
                          onChange={(e) =>
                            void run(() => hrApi.assignRoster(outletId, { entries: [{ staffId: s.id, date: d, templateId: e.target.value || null }] }))
                          }
                        >
                          <option value="">Off</option>
                          {sh && !sh.templateId && <option value="custom">{sh.startTime}–{sh.endTime}</option>}
                          {templates.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                        {sh && <span className="faint mono" style={{ fontSize: 11 }}>{sh.startTime}–{sh.endTime}</span>}
                        {lv && <span className="roster-leave">{lv.type.toLowerCase()} leave</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {week && week.staff.length === 0 && <tr><td colSpan={8} className="empty">Add staff profiles first.</td></tr>}
            </tbody>
          </table>
        </div>

        <aside>
          <section className="side-card">
            <h3>Shift templates</h3>
            <ul className="vendor-list">
              {templates.map((t) => (
                <li key={t.id}>
                  <span>{t.name}</span>
                  <span className="faint mono">{t.startTime}–{t.endTime} · {t.breakMinutes}m break · {t.graceMinutes}m grace</span>
                  <button className="text-btn danger" onClick={() => void run(() => hrApi.deleteTemplate(outletId, t.id))}>Remove</button>
                </li>
              ))}
              {templates.length === 0 && <li className="hint">No templates yet.</li>}
            </ul>
            <div className="hr-form" style={{ marginTop: 10 }}>
              <label className="field wide">Name<input value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} placeholder="Morning" /></label>
              <label className="field">Start<input type="time" value={tpl.startTime} onChange={(e) => setTpl({ ...tpl, startTime: e.target.value })} /></label>
              <label className="field">End<input type="time" value={tpl.endTime} onChange={(e) => setTpl({ ...tpl, endTime: e.target.value })} /></label>
              <label className="field">Break (min)<input type="number" min={0} value={tpl.breakMinutes} onChange={(e) => setTpl({ ...tpl, breakMinutes: Number(e.target.value) || 0 })} /></label>
              <label className="field">Grace (min)<input type="number" min={0} value={tpl.graceMinutes} onChange={(e) => setTpl({ ...tpl, graceMinutes: Number(e.target.value) || 0 })} /></label>
            </div>
            <button
              className="btn-primary sm"
              style={{ marginTop: 10 }}
              disabled={!tpl.name.trim()}
              onClick={() => void run(async () => { await hrApi.createTemplate(outletId, { ...tpl, name: tpl.name.trim() }); setTpl({ ...tpl, name: "" }); })}
            >
              + Add template
            </button>
            <p className="hint">An end time earlier than the start is an overnight shift.</p>
          </section>

          <section className="side-card">
            <h3>Shift swaps</h3>
            <div className="hr-form">
              <label className="field wide">
                Shift to give away
                <select value={swap.fromShiftId} onChange={(e) => setSwap({ ...swap, fromShiftId: e.target.value })}>
                  <option value="">Pick a shift this week…</option>
                  {week?.shifts.map((s) => (
                    <option key={s.id} value={s.id}>{nameOf.get(s.staffId)} · {s.date.slice(5)} {s.startTime}</option>
                  ))}
                </select>
              </label>
              <label className="field wide">
                Covered by
                <select value={swap.toStaffId} onChange={(e) => setSwap({ ...swap, toStaffId: e.target.value, toShiftId: "" })}>
                  <option value="">Pick staff…</option>
                  {week?.staff.filter((s) => s.id !== fromShift?.staffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="field wide">
                In exchange for (optional)
                <select value={swap.toShiftId} onChange={(e) => setSwap({ ...swap, toShiftId: e.target.value })}>
                  <option value="">Nothing — straight cover</option>
                  {week?.shifts.filter((s) => s.staffId === swap.toStaffId).map((s) => (
                    <option key={s.id} value={s.id}>{s.date.slice(5)} {s.startTime}–{s.endTime}</option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className="btn-primary sm"
              style={{ marginTop: 10 }}
              disabled={!swap.fromShiftId || !swap.toStaffId}
              onClick={() =>
                void run(async () => {
                  await hrApi.requestSwap(outletId, { fromShiftId: swap.fromShiftId, toStaffId: swap.toStaffId, toShiftId: swap.toShiftId || null });
                  setSwap({ fromShiftId: "", toStaffId: "", toShiftId: "" });
                })
              }
            >
              Request swap
            </button>
            <ul className="vendor-list" style={{ marginTop: 12 }}>
              {swaps.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <span>
                    {r.fromShift.staffName} → {r.toStaffName}
                    <span className="faint mono"> {r.fromShift.date?.slice(5)}{r.toShift ? ` ⇄ ${r.toShift.date.slice(5)}` : ""}</span>
                  </span>
                  {r.status === "PENDING" ? (
                    <span>
                      <button className="text-btn" onClick={() => void run(() => hrApi.decideSwap(outletId, r.id, { approve: true }))}>Approve</button>
                      <button className="text-btn danger" onClick={() => void run(() => hrApi.decideSwap(outletId, r.id, { approve: false }))}>Reject</button>
                    </span>
                  ) : (
                    <span className={`status-pill ${r.status === "APPROVED" ? "good" : "muted"}`}>{r.status}</span>
                  )}
                </li>
              ))}
              {swaps.length === 0 && <li className="hint">No swap requests.</li>}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
