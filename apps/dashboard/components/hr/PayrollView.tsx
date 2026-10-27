"use client";

import { useCallback, useEffect, useState } from "react";
import type { PayAdjustment, PayrollConfig, PayrollRunDto, PayrollRunRowDto, PayslipDto, SalaryAdvanceDto, StaffDto } from "@stello/shared";
import { downloadText, hm, hrApi, inr, todayIst } from "@/lib/hr-api";

const lastMonth = () => {
  const [y, m] = todayIst().split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

export function PayrollView({ outletId }: { outletId: string }) {
  const [month, setMonth] = useState(lastMonth());
  const [runs, setRuns] = useState<PayrollRunRowDto[]>([]);
  const [run, setRun] = useState<PayrollRunDto | null>(null);
  const [slip, setSlip] = useState<PayslipDto | null>(null);
  const [editSlip, setEditSlip] = useState<PayslipDto | null>(null);
  const [panel, setPanel] = useState<"advances" | "settings">("advances");
  const [confirmFinal, setConfirmFinal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRuns(await hrApi.payrollRuns(outletId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payroll");
    }
  }, [outletId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<PayrollRunDto | unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "payslips" in res) setRun(res as PayrollRunDto);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
      setConfirmFinal(false);
    }
  };

  const draft = run?.status === "DRAFT";

  return (
    <>
      <div className="hr-subnav">
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <button className="btn-primary sm" disabled={busy} onClick={() => void act(() => hrApi.computePayroll(outletId, month))}>
          {runs.some((r) => r.month === month) ? "Recompute draft" : "Run payroll"}
        </button>
        <span style={{ flex: 1 }} />
        {runs.map((r) => (
          <button key={r.id} className={`range-tab ${run?.id === r.id ? "active" : ""}`} onClick={() => void act(() => hrApi.payrollRun(outletId, r.id))}>
            {r.month} · {r.status === "FINALISED" ? "🔒" : "draft"}
          </button>
        ))}
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="hr-grid-2">
        <div>
          {!run && <p className="empty">Pick a month and run payroll, or open an existing run.</p>}
          {run && (
            <>
              <div className="pane-head" style={{ padding: 0, marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>
                  {monthLabel(run.month)} <span className={`status-pill ${draft ? "info" : "good"}`}>{draft ? "Draft" : "Finalised"}</span>
                </h2>
                <div className="hr-toolbar">
                  <button className="btn-ghost sm" onClick={() => void hrApi.payrollCsv(outletId, run.id).then((r) => downloadText(r.filename, r.csv, "text/csv"))}>
                    CSV
                  </button>
                  {draft && (
                    <>
                      <button className="btn-ghost sm" disabled={busy} onClick={() => void act(async () => { await hrApi.deletePayroll(outletId, run.id); setRun(null); })}>
                        Delete draft
                      </button>
                      <button
                        className={`btn-primary sm ${confirmFinal ? "danger" : ""}`}
                        disabled={busy}
                        onClick={() => (confirmFinal ? void act(() => hrApi.finalisePayroll(outletId, run.id)) : setConfirmFinal(true))}
                      >
                        {confirmFinal ? "Confirm — lock payroll" : "Finalise"}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="inv-stats">
                <div className="stat"><span className="stat-label">Staff</span><span className="stat-value">{run.payslips.length}</span></div>
                <div className="stat"><span className="stat-label">Gross</span><span className="stat-value">{inr(run.totals.gross)}</span></div>
                <div className="stat"><span className="stat-label">Net payable</span><span className="stat-value">{inr(run.totals.net)}</span></div>
                <div className="stat"><span className="stat-label">Employer cost</span><span className="stat-value">{inr(run.totals.employerCost)}</span></div>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th className="num">Present</th>
                    <th className="num">Paid leave</th>
                    <th className="num">LOP</th>
                    <th className="num">OT</th>
                    <th className="num">Gross</th>
                    <th className="num">Deductions</th>
                    <th className="num">Net</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {run.payslips.map((p) => (
                    <tr key={p.id}>
                      <td className="strong">
                        {p.staffName}
                        <div className="faint">{p.employeeCode} · {p.payType.toLowerCase()}</div>
                        {p.calc.warnings.map((w) => <div key={w} className="ps-warn">{w}</div>)}
                      </td>
                      <td className="num mono">{p.attendance.presentDays}</td>
                      <td className="num mono">{p.attendance.paidLeaveDays}</td>
                      <td className="num mono">{p.lopDays}</td>
                      <td className="num mono">{p.overtimeMinutes ? hm(p.overtimeMinutes) : "—"}</td>
                      <td className="num mono">{inr(p.calc.gross)}</td>
                      <td className="num mono">{inr(p.calc.totalDeductions)}</td>
                      <td className="num mono strong">{inr(p.calc.net)}</td>
                      <td className="row-actions">
                        <button className="text-btn" onClick={() => setSlip(p)}>Payslip</button>
                        {draft && <button className="text-btn" onClick={() => setEditSlip(p)}>Adjust</button>}
                      </td>
                    </tr>
                  ))}
                  {run.payslips.length === 0 && <tr><td colSpan={9} className="empty">No eligible staff for this month.</td></tr>}
                </tbody>
              </table>
              {draft && <p className="hint">Draft figures come from attendance, approved leave and the roster. Recompute after corrections; adjustments are kept.</p>}
            </>
          )}
        </div>

        <aside className="side-card">
          <div className="range-tabs" style={{ marginBottom: 12 }}>
            <button className={`range-tab ${panel === "advances" ? "active" : ""}`} onClick={() => setPanel("advances")}>Advances</button>
            <button className={`range-tab ${panel === "settings" ? "active" : ""}`} onClick={() => setPanel("settings")}>Statutory settings</button>
          </div>
          {panel === "advances" ? <Advances outletId={outletId} /> : <Settings outletId={outletId} />}
        </aside>
      </div>

      {slip && run && <PayslipModal run={run} slip={slip} onClose={() => setSlip(null)} />}
      {editSlip && run && (
        <AdjustModal
          slip={editSlip}
          onClose={() => setEditSlip(null)}
          onSave={async (input) => {
            await hrApi.updatePayslip(outletId, run.id, editSlip.id, input);
            setEditSlip(null);
            await act(() => hrApi.payrollRun(outletId, run.id));
          }}
        />
      )}
    </>
  );
}

function Advances({ outletId }: { outletId: string }) {
  const [list, setList] = useState<SalaryAdvanceDto[]>([]);
  const [staff, setStaff] = useState<StaffDto[]>([]);
  const [form, setForm] = useState({ staffId: "", amount: "", monthlyRecovery: "", paidFrom: "BANK" as "BANK" | "CASH_DRAWER" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [a, s] = await Promise.all([hrApi.advances(outletId), hrApi.staff(outletId)]);
    setList(a);
    setStaff(s.filter((x) => x.isActive));
  }, [outletId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);
  const give = async () => {
    setError(null);
    try {
      await hrApi.giveAdvance(outletId, {
        staffId: form.staffId,
        amount: Number(form.amount),
        monthlyRecovery: Number(form.monthlyRecovery),
        givenOn: todayIst(),
        paidFrom: form.paidFrom,
      });
      setForm({ ...form, amount: "", monthlyRecovery: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record advance");
    }
  };
  return (
    <>
      <ul className="vendor-list">
        {list.map((a) => (
          <li key={a.id}>
            <span>{a.staffName}</span>
            <span className="faint mono">
              {inr(a.amount)} · {inr(a.monthlyRecovery)}/mo · {a.status === "OPEN" ? `${inr(a.outstanding)} due` : "recovered"}
            </span>
          </li>
        ))}
        {list.length === 0 && <li className="hint">No salary advances.</li>}
      </ul>
      <div className="hr-form" style={{ marginTop: 10 }}>
        <label className="field wide">
          Staff
          <select value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
            <option value="">Pick staff…</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field">Amount<input type="number" min={0} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label className="field">Recover / month<input type="number" min={0} value={form.monthlyRecovery} onChange={(e) => setForm({ ...form, monthlyRecovery: e.target.value })} /></label>
        <label className="field wide">
          Paid from
          <select value={form.paidFrom} onChange={(e) => setForm({ ...form, paidFrom: e.target.value as "BANK" | "CASH_DRAWER" })}>
            <option value="BANK">Bank / UPI</option>
            <option value="CASH_DRAWER">Cash drawer</option>
          </select>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <button className="btn-primary sm" style={{ marginTop: 10 }} disabled={!form.staffId || !Number(form.amount) || !Number(form.monthlyRecovery)} onClick={give}>
        Give advance
      </button>
    </>
  );
}

function Settings({ outletId }: { outletId: string }) {
  const [cfg, setCfg] = useState<PayrollConfig | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void hrApi.payrollConfig(outletId).then(setCfg).catch(() => setMsg("Could not load settings"));
  }, [outletId]);
  if (!cfg) return <p className="hint">{msg ?? "Loading…"}</p>;
  const num = (v: string) => Number(v) || 0;
  const save = async () => {
    try {
      setCfg(await hrApi.setPayrollConfig(outletId, cfg));
      setMsg("Saved. Recompute drafts to apply.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not save");
    }
  };
  return (
    <>
      <p className="hr-note">
        These defaults are illustrative, not legal advice. PF/ESI rates, wage ceilings and professional-tax slabs vary by state and change
        over time — confirm them with your accountant before finalising payroll.
      </p>
      <div className="hr-form">
        <label className="field">
          Monthly basis
          <select value={String(cfg.monthlyBasis)} onChange={(e) => setCfg({ ...cfg, monthlyBasis: e.target.value === "CALENDAR" ? "CALENDAR" : (Number(e.target.value) as 26 | 30) })}>
            <option value="CALENDAR">Calendar days</option>
            <option value="26">26 days</option>
            <option value="30">30 days</option>
          </select>
        </label>
        <label className="field">Std day (h)<input type="number" value={cfg.standardDayHours} onChange={(e) => setCfg({ ...cfg, standardDayHours: num(e.target.value) })} /></label>
        <label className="field">Half day below (h)<input type="number" value={cfg.halfDayHours} onChange={(e) => setCfg({ ...cfg, halfDayHours: num(e.target.value) })} /></label>
        <label className="field">OT multiplier<input type="number" step={0.25} value={cfg.overtimeMultiplier} onChange={(e) => setCfg({ ...cfg, overtimeMultiplier: num(e.target.value) })} /></label>
        <label className="field">OT after (min)<input type="number" value={cfg.overtimeThresholdMinutes} onChange={(e) => setCfg({ ...cfg, overtimeThresholdMinutes: num(e.target.value) })} /></label>
        <label className="hr-check wide"><input type="checkbox" checked={cfg.pf.enabled} onChange={(e) => setCfg({ ...cfg, pf: { ...cfg.pf, enabled: e.target.checked } })} />Provident fund</label>
        <label className="field">PF employee %<input type="number" step={0.01} value={cfg.pf.employeeRate} onChange={(e) => setCfg({ ...cfg, pf: { ...cfg.pf, employeeRate: num(e.target.value) } })} /></label>
        <label className="field">PF employer %<input type="number" step={0.01} value={cfg.pf.employerRate} onChange={(e) => setCfg({ ...cfg, pf: { ...cfg.pf, employerRate: num(e.target.value) } })} /></label>
        <label className="field">PF wage ceiling ₹<input type="number" value={cfg.pf.wageCeiling} onChange={(e) => setCfg({ ...cfg, pf: { ...cfg.pf, wageCeiling: num(e.target.value) } })} /></label>
        <label className="hr-check wide"><input type="checkbox" checked={cfg.esi.enabled} onChange={(e) => setCfg({ ...cfg, esi: { ...cfg.esi, enabled: e.target.checked } })} />ESI</label>
        <label className="field">ESI employee %<input type="number" step={0.01} value={cfg.esi.employeeRate} onChange={(e) => setCfg({ ...cfg, esi: { ...cfg.esi, employeeRate: num(e.target.value) } })} /></label>
        <label className="field">ESI employer %<input type="number" step={0.01} value={cfg.esi.employerRate} onChange={(e) => setCfg({ ...cfg, esi: { ...cfg.esi, employerRate: num(e.target.value) } })} /></label>
        <label className="field">ESI gross limit ₹<input type="number" value={cfg.esi.grossThreshold} onChange={(e) => setCfg({ ...cfg, esi: { ...cfg.esi, grossThreshold: num(e.target.value) } })} /></label>
        <label className="hr-check wide"><input type="checkbox" checked={cfg.pt.enabled} onChange={(e) => setCfg({ ...cfg, pt: { ...cfg.pt, enabled: e.target.checked } })} />Professional tax (slabs on monthly gross)</label>
        {cfg.pt.slabs.map((s, i) => (
          <div key={i} className="hr-line wide">
            <input
              type="number"
              placeholder="Up to ₹ (blank = above)"
              value={s.upTo ?? ""}
              onChange={(e) => setCfg({ ...cfg, pt: { ...cfg.pt, slabs: cfg.pt.slabs.map((x, j) => (j === i ? { ...x, upTo: e.target.value === "" ? null : num(e.target.value) } : x)) } })}
            />
            <input
              type="number"
              placeholder="Tax ₹"
              value={s.amount}
              onChange={(e) => setCfg({ ...cfg, pt: { ...cfg.pt, slabs: cfg.pt.slabs.map((x, j) => (j === i ? { ...x, amount: num(e.target.value) } : x)) } })}
            />
            <button className="del-row" onClick={() => setCfg({ ...cfg, pt: { ...cfg.pt, slabs: cfg.pt.slabs.filter((_, j) => j !== i) } })}>✕</button>
          </div>
        ))}
        <button className="add-row wide" onClick={() => setCfg({ ...cfg, pt: { ...cfg.pt, slabs: [...cfg.pt.slabs, { upTo: null, amount: 0 }] } })}>+ Add PT slab</button>
      </div>
      {msg && <p className="hint">{msg}</p>}
      <button className="btn-primary sm" style={{ marginTop: 10 }} onClick={save}>Save settings</button>
    </>
  );
}

function AdjustModal({ slip, onClose, onSave }: { slip: PayslipDto; onClose: () => void; onSave: (i: { lopDays: number; overtimeMinutes: number; adjustments: PayAdjustment[]; note: string | null }) => Promise<void> }) {
  const [lop, setLop] = useState(slip.lopDays);
  const [otHours, setOtHours] = useState(Math.round((slip.overtimeMinutes / 60) * 100) / 100);
  const [adj, setAdj] = useState<PayAdjustment[]>(slip.adjustments);
  const [note, setNote] = useState(slip.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await onSave({ lopDays: lop, overtimeMinutes: Math.round(otHours * 60), adjustments: adj.filter((a) => a.name.trim() && a.amount > 0), note: note || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Adjust · {slip.staffName}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <p className="hint">
            From attendance: {slip.attendance.presentDays} present, {slip.attendance.paidLeaveDays} paid leave, {slip.attendance.absentDays} absent,{" "}
            {slip.attendance.lateDays} late day(s).
          </p>
          <div className="field-row">
            <label className="field">LOP days<input type="number" min={0} step={0.5} value={lop} onChange={(e) => setLop(Number(e.target.value) || 0)} /></label>
            <label className="field">Overtime (hours)<input type="number" min={0} step={0.25} value={otHours} onChange={(e) => setOtHours(Number(e.target.value) || 0)} /></label>
          </div>
          <section className="editor-section">
            <div className="section-head">
              <h3>One-off adjustments</h3>
              <button className="add-row" onClick={() => setAdj([...adj, { name: "", amount: 0, kind: "EARNING" }])}>+ Add</button>
            </div>
            {adj.map((a, i) => (
              <div key={i} className="hr-line" style={{ gridTemplateColumns: "1fr 110px 120px 32px", marginBottom: 6 }}>
                <input placeholder="Bonus, fine…" value={a.name} onChange={(e) => setAdj(adj.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input type="number" min={0} value={a.amount || ""} onChange={(e) => setAdj(adj.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) || 0 } : x)))} />
                <select value={a.kind} onChange={(e) => setAdj(adj.map((x, j) => (j === i ? { ...x, kind: e.target.value as PayAdjustment["kind"] } : x)))}>
                  <option value="EARNING">Earning</option>
                  <option value="DEDUCTION">Deduction</option>
                </select>
                <button className="del-row" onClick={() => setAdj(adj.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </section>
          <label className="field">Note<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary grow" onClick={save}>Save & recompute</button>
        </footer>
      </div>
    </div>
  );
}

function PayslipModal({ run, slip, onClose }: { run: PayrollRunDto; slip: PayslipDto; onClose: () => void }) {
  const c = slip.calc;
  const earnings = [{ name: "Basic / wages", amount: c.basic }, ...(c.overtimePay ? [{ name: `Overtime (${c.overtimeHours} h)`, amount: c.overtimePay }] : []), ...c.earnings];
  const deductions = [
    ...(c.pfEmployee ? [{ name: "Provident fund", amount: c.pfEmployee }] : []),
    ...(c.esiEmployee ? [{ name: "ESI", amount: c.esiEmployee }] : []),
    ...(c.professionalTax ? [{ name: "Professional tax", amount: c.professionalTax }] : []),
    ...(c.advanceRecovery ? [{ name: "Advance recovery", amount: c.advanceRecovery }] : []),
    ...c.otherDeductions,
  ];
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
        <header className="modal-head no-print">
          <h2>Payslip</h2>
          <div className="hr-toolbar">
            <button className="btn-primary sm" onClick={() => window.print()}>Print</button>
            <button className="modal-x" onClick={onClose}>✕</button>
          </div>
        </header>
        <div className="modal-body">
          <div className="payslip print-area">
            <h3>{run.outletName}</h3>
            <div className="faint">Payslip for {monthLabel(run.month)}{run.status === "DRAFT" ? " · DRAFT" : ""}</div>
            <div className="ps-cols">
              <div>
                <div className="ps-row"><span>Employee</span><strong>{slip.staffName}</strong></div>
                <div className="ps-row"><span>Code</span><span>{slip.employeeCode}</span></div>
                <div className="ps-row"><span>Designation</span><span>{slip.designation ?? "—"}</span></div>
              </div>
              <div>
                <div className="ps-row"><span>Days in month</span><span>{slip.daysInMonth}</span></div>
                <div className="ps-row"><span>Payable days</span><span>{c.payableDays}</span></div>
                <div className="ps-row"><span>Present / paid leave / LOP</span><span>{slip.attendance.presentDays} / {slip.attendance.paidLeaveDays} / {slip.lopDays}</span></div>
              </div>
            </div>
            <div className="ps-cols">
              <div>
                <strong>Earnings</strong>
                {earnings.map((l) => <div key={l.name} className="ps-row"><span>{l.name}</span><span>{inr(l.amount)}</span></div>)}
                <div className="ps-row ps-total"><span>Gross</span><span>{inr(c.gross)}</span></div>
              </div>
              <div>
                <strong>Deductions</strong>
                {deductions.map((l) => <div key={l.name} className="ps-row"><span>{l.name}</span><span>{inr(l.amount)}</span></div>)}
                {deductions.length === 0 && <div className="ps-row"><span>None</span><span>—</span></div>}
                <div className="ps-row ps-total"><span>Total deductions</span><span>{inr(c.totalDeductions)}</span></div>
              </div>
            </div>
            <div className="ps-net"><span>Net pay</span><span>{inr(c.net)}</span></div>
            {(c.pfEmployer > 0 || c.esiEmployer > 0) && (
              <div className="faint" style={{ marginTop: 8 }}>Employer contributions: PF {inr(c.pfEmployer)} · ESI {inr(c.esiEmployer)}</div>
            )}
            {slip.note && <div className="faint" style={{ marginTop: 8 }}>Note: {slip.note}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
