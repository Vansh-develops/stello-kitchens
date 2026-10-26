"use client";

import { useCallback, useEffect, useState } from "react";
import type { LeaveBalanceDto, LeaveRequestDto, LeaveRequestInput, LeaveType, StaffDto } from "@stello/shared";
import { hrApi, todayIst } from "@/lib/hr-api";

const TYPES: LeaveType[] = ["CASUAL", "SICK", "EARNED", "UNPAID"];
const TONE: Record<string, string> = { PENDING: "info", APPROVED: "good", REJECTED: "bad", CANCELLED: "muted" };
const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function LeaveView({ outletId }: { outletId: string }) {
  const [year, setYear] = useState(Number(todayIst().slice(0, 4)));
  const [requests, setRequests] = useState<LeaveRequestDto[]>([]);
  const [balances, setBalances] = useState<LeaveBalanceDto[]>([]);
  const [staff, setStaff] = useState<StaffDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<LeaveRequestInput>({ staffId: "", type: "CASUAL", fromDate: todayIst(), toDate: todayIst(), halfDay: false, reason: "" });

  const reload = useCallback(async () => {
    try {
      const [r, b, s] = await Promise.all([hrApi.leaves(outletId), hrApi.leaveBalances(outletId, year), hrApi.staff(outletId)]);
      setRequests(r);
      setBalances(b);
      setStaff(s.filter((x) => x.isActive));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load leave");
    }
  }, [outletId, year]);
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

  return (
    <>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <div className="hr-grid-2">
        <div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Staff</th>
                <th>Type</th>
                <th>Dates</th>
                <th className="num">Days</th>
                <th>Reason</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="strong">{r.staffName}</td>
                  <td>{r.type.toLowerCase()}</td>
                  <td className="mono">{fmt(r.fromDate)}{r.toDate !== r.fromDate && ` – ${fmt(r.toDate)}`}{r.halfDay && " (½)"}</td>
                  <td className="num mono">{r.days}</td>
                  <td className="faint">{r.reason ?? "—"}</td>
                  <td><span className={`status-pill ${TONE[r.status]}`}>{r.status}</span></td>
                  <td className="row-actions">
                    {r.status === "PENDING" && (
                      <>
                        <button className="text-btn" onClick={() => void run(() => hrApi.decideLeave(outletId, r.id, { approve: true }))}>Approve</button>
                        <button className="text-btn danger" onClick={() => void run(() => hrApi.decideLeave(outletId, r.id, { approve: false }))}>Reject</button>
                      </>
                    )}
                    {r.status === "APPROVED" && (
                      <button className="text-btn danger" onClick={() => void run(() => hrApi.cancelLeave(outletId, r.id))}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && <tr><td colSpan={7} className="empty">No leave requests.</td></tr>}
            </tbody>
          </table>

          <div className="hr-subnav" style={{ marginTop: 20 }}>
            <h3 style={{ margin: 0 }}>Leave balances</h3>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span className="hint" style={{ margin: 0 }}>Edit the allotted days; used days update on approval.</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Staff</th>
                <th>Casual (used / allotted)</th>
                <th>Sick</th>
                <th>Earned</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.staffId}>
                  <td className="strong">{b.staffName}</td>
                  {b.balances.map((x) => (
                    <td key={x.type}>
                      <span className="mono">{x.used} / </span>
                      <input
                        key={`${x.type}-${x.allotted}`}
                        type="number"
                        min={0}
                        step={0.5}
                        defaultValue={x.allotted}
                        style={{ width: 70 }}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v !== x.allotted && v >= 0) void run(() => hrApi.setLeaveBalance(outletId, { staffId: b.staffId, year, type: x.type, allotted: v }));
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="side-card">
          <h3>New leave request</h3>
          <div className="hr-form">
            <label className="field wide">
              Staff
              <select value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
                <option value="">Pick staff…</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="field wide">
              Type
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as LeaveType })}>
                {TYPES.map((t) => <option key={t} value={t}>{t.toLowerCase()}</option>)}
              </select>
            </label>
            <label className="field">From<input type="date" value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value, toDate: form.halfDay || e.target.value > form.toDate ? e.target.value : form.toDate })} /></label>
            <label className="field">To<input type="date" value={form.toDate} disabled={form.halfDay} onChange={(e) => setForm({ ...form, toDate: e.target.value })} /></label>
            <label className="hr-check wide">
              <input type="checkbox" checked={form.halfDay} onChange={(e) => setForm({ ...form, halfDay: e.target.checked, toDate: form.fromDate })} />
              Half day
            </label>
            <label className="field wide">Reason<input value={form.reason ?? ""} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
          </div>
          <button
            className="btn-primary sm"
            style={{ marginTop: 10 }}
            disabled={!form.staffId}
            onClick={() => void run(async () => { await hrApi.requestLeave(outletId, { ...form, reason: form.reason || undefined }); setForm({ ...form, reason: "" }); })}
          >
            Submit for approval
          </button>
        </aside>
      </div>
    </>
  );
}
