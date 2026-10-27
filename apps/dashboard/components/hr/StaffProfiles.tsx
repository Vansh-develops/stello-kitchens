"use client";

import { useCallback, useEffect, useState } from "react";
import type { PayComponent, PayType, StaffDto, StaffInput } from "@stello/shared";
import { hrApi, inr, todayIst } from "@/lib/hr-api";

const PAY_LABEL: Record<PayType, string> = { MONTHLY: "/ month", DAILY: "/ day", HOURLY: "/ hour" };

export function StaffProfiles({ outletId }: { outletId: string }) {
  const [staff, setStaff] = useState<StaffDto[]>([]);
  const [editing, setEditing] = useState<StaffDto | "new" | null>(null);
  const [pinFor, setPinFor] = useState<StaffDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setStaff(await hrApi.staff(outletId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load staff");
    }
  }, [outletId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <div className="hr-subnav">
        <p className="hint" style={{ margin: 0, flex: 1 }}>
          Staff profiles with pay details. Link a login for staff who use the POS; helpers without a login clock in with a PIN.
        </p>
        <button className="btn-primary sm" onClick={() => setEditing("new")}>+ Add staff</button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Designation</th>
            <th>Login</th>
            <th className="num">Pay</th>
            <th>Statutory</th>
            <th>PIN</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.id} className={s.isActive ? "" : "low"}>
              <td className="mono">{s.employeeCode}</td>
              <td className="strong">
                {s.name}
                {!s.isActive && <span className="faint"> · inactive</span>}
              </td>
              <td>{s.designation ?? <span className="faint">—</span>}</td>
              <td className="faint">{s.userEmail ?? "No login"}</td>
              <td className="num mono">
                {inr(s.payRate)} <span className="unit">{PAY_LABEL[s.payType]}</span>
              </td>
              <td className="faint">{[s.pfApplicable && "PF", s.esiApplicable && "ESI", s.ptApplicable && "PT"].filter(Boolean).join(" · ") || "—"}</td>
              <td>
                <span className={`status-pill ${s.hasPin ? "good" : "muted"}`}>{s.hasPin ? "Set" : "None"}</span>
              </td>
              <td className="row-actions">
                <button className="text-btn" onClick={() => setPinFor(s)}>PIN</button>
                <button className="text-btn" onClick={() => setEditing(s)}>Edit</button>
              </td>
            </tr>
          ))}
          {staff.length === 0 && (
            <tr>
              <td colSpan={8} className="empty">No staff yet. Add your team to track attendance and run payroll.</td>
            </tr>
          )}
        </tbody>
      </table>
      {editing && (
        <StaffDialog
          outletId={outletId}
          staff={editing === "new" ? null : editing}
          nextCode={`E${String(staff.length + 1).padStart(3, "0")}`}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {pinFor && <PinDialog outletId={outletId} staff={pinFor} onClose={() => setPinFor(null)} onSaved={() => { setPinFor(null); void reload(); }} />}
    </>
  );
}

function ComponentLines({ label, lines, onChange }: { label: string; lines: PayComponent[]; onChange: (l: PayComponent[]) => void }) {
  return (
    <section className="editor-section">
      <div className="section-head">
        <h3>{label}</h3>
        <button className="add-row" onClick={() => onChange([...lines, { name: "", amount: 0 }])}>+ Add</button>
      </div>
      <div className="hr-lines">
        {lines.map((l, i) => (
          <div key={i} className="hr-line">
            <input placeholder="Name" value={l.name} onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input
              type="number"
              min={0}
              placeholder="₹ / month"
              value={l.amount || ""}
              onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) || 0 } : x)))}
            />
            <button className="del-row" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
          </div>
        ))}
        {lines.length === 0 && <p className="hint">None.</p>}
      </div>
    </section>
  );
}

function StaffDialog({
  outletId,
  staff,
  nextCode,
  onClose,
  onSaved,
}: {
  outletId: string;
  staff: StaffDto | null;
  nextCode: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<StaffInput>(() => ({
    outletId,
    employeeCode: staff?.employeeCode ?? nextCode,
    name: staff?.name ?? "",
    phone: staff?.phone ?? "",
    designation: staff?.designation ?? "",
    joiningDate: staff?.joiningDate ?? todayIst(),
    exitDate: staff?.exitDate ?? null,
    userId: staff?.userId ?? null,
    payType: staff?.payType ?? "MONTHLY",
    payRate: staff?.payRate ?? 0,
    allowances: staff?.allowances ?? [],
    deductions: staff?.deductions ?? [],
    pfApplicable: staff?.pfApplicable ?? false,
    esiApplicable: staff?.esiApplicable ?? false,
    ptApplicable: staff?.ptApplicable ?? false,
    overtimeEligible: staff?.overtimeEligible ?? true,
    isActive: staff?.isActive ?? true,
  }));
  const [users, setUsers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof StaffInput>(k: K, v: StaffInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    void hrApi.linkableUsers(outletId).then(setUsers).catch(() => setUsers([]));
  }, [outletId]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: StaffInput = {
        ...form,
        phone: form.phone || null,
        designation: form.designation || null,
        exitDate: form.exitDate || null,
        allowances: form.allowances.filter((a) => a.name.trim() && a.amount > 0),
        deductions: form.deductions.filter((a) => a.name.trim() && a.amount > 0),
      };
      if (staff) await hrApi.updateStaff(outletId, staff.id, body);
      else await hrApi.createStaff(outletId, body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  const linkOptions = staff?.userId && !users.some((u) => u.id === staff.userId)
    ? [{ id: staff.userId, name: staff.userEmail ?? "Linked login", email: staff.userEmail ?? "" }, ...users]
    : users;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{staff ? `Edit ${staff.name}` : "Add staff member"}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <div className="hr-form">
            <label className="field">Name<input value={form.name} onChange={(e) => set("name", e.target.value)} /></label>
            <label className="field">Employee code<input value={form.employeeCode} onChange={(e) => set("employeeCode", e.target.value)} /></label>
            <label className="field">Designation<input value={form.designation ?? ""} onChange={(e) => set("designation", e.target.value)} placeholder="Cook, Waiter…" /></label>
            <label className="field">Phone<input value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} inputMode="tel" /></label>
            <label className="field">Joining date<input type="date" value={form.joiningDate} onChange={(e) => set("joiningDate", e.target.value)} /></label>
            <label className="field">Exit date<input type="date" value={form.exitDate ?? ""} onChange={(e) => set("exitDate", e.target.value || null)} /></label>
            <label className="field wide">
              Login (optional)
              <select value={form.userId ?? ""} onChange={(e) => set("userId", e.target.value || null)}>
                <option value="">No login (PIN clock-in only)</option>
                {linkOptions.map((u) => (
                  <option key={u.id} value={u.id}>{u.name} · {u.email}</option>
                ))}
              </select>
            </label>
          </div>
          <section className="editor-section">
            <h3>Pay profile</h3>
            <div className="hr-form">
              <label className="field">
                Pay type
                <select value={form.payType} onChange={(e) => set("payType", e.target.value as PayType)}>
                  <option value="MONTHLY">Fixed monthly salary</option>
                  <option value="DAILY">Daily wage</option>
                  <option value="HOURLY">Hourly</option>
                </select>
              </label>
              <label className="field">
                Rate (₹ {PAY_LABEL[form.payType]})
                <input type="number" min={0} value={form.payRate || ""} onChange={(e) => set("payRate", Number(e.target.value) || 0)} />
              </label>
            </div>
            <div className="hr-checks" style={{ marginTop: 12 }}>
              <label className="hr-check"><input type="checkbox" checked={form.pfApplicable} onChange={(e) => set("pfApplicable", e.target.checked)} />PF</label>
              <label className="hr-check"><input type="checkbox" checked={form.esiApplicable} onChange={(e) => set("esiApplicable", e.target.checked)} />ESI</label>
              <label className="hr-check"><input type="checkbox" checked={form.ptApplicable} onChange={(e) => set("ptApplicable", e.target.checked)} />Professional tax</label>
              <label className="hr-check"><input type="checkbox" checked={form.overtimeEligible} onChange={(e) => set("overtimeEligible", e.target.checked)} />Overtime pay</label>
              <label className="hr-check"><input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />Active</label>
            </div>
          </section>
          <ComponentLines label="Monthly allowances" lines={form.allowances} onChange={(l) => set("allowances", l)} />
          <ComponentLines label="Monthly deductions" lines={form.deductions} onChange={(l) => set("deductions", l)} />
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary grow" onClick={save} disabled={busy || !form.name.trim() || !form.employeeCode.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PinDialog({ outletId, staff, onClose, onSaved }: { outletId: string; staff: StaffDto; onClose: () => void; onSaved: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await hrApi.setPin(outletId, staff.id, pin);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set PIN");
    }
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <header className="modal-head">
          <h2>Clock-in PIN · {staff.name}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <p className="hint">4–6 digits. Staff tap their name on the POS clock screen and enter this PIN.</p>
          <label className="field">
            New PIN
            <input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoFocus />
          </label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary grow" onClick={save} disabled={pin.length < 4}>Set PIN</button>
        </footer>
      </div>
    </div>
  );
}
