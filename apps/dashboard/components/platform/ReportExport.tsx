"use client";

import { useCallback, useEffect, useState } from "react";
import {
  REPORT_EXPORTS,
  hasPermission,
  type CustomReportInput,
  type ExportFormat,
  type ReportExportKey,
  type ReportScheduleDto,
  type ReportScheduleInput,
} from "@stello/shared";
import { platformApi } from "@/lib/platform-api";
import { useSession } from "@/components/SessionProvider";
import "./platform.css";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function useCan(perm: string) {
  const { user } = useSession();
  return !!user && hasPermission(user.permissions, perm);
}

/** "Download CSV / Excel" for any report in the current range (server-generated, streamed). */
export function ReportExportBar({ outletId, from, to }: { outletId: string; from: string; to: string }) {
  const can = useCan("reports.export");
  const [report, setReport] = useState<"all" | ReportExportKey>("all");
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!can) return null;
  const go = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      await platformApi.exportReport(outletId, report, format, from, to);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="pf-export">
      <span className="pf-faint">Export {from === to ? from : `${from} → ${to}`}</span>
      <select value={report} onChange={(e) => setReport(e.target.value as typeof report)} aria-label="Report to export">
        <option value="all">All reports (one sheet each)</option>
        {REPORT_EXPORTS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
      <button className="btn-ghost sm" disabled={!!busy} onClick={() => void go("csv")}>{busy === "csv" ? "Preparing…" : "CSV"}</button>
      <button className="btn-primary sm" disabled={!!busy} onClick={() => void go("xlsx")}>{busy === "xlsx" ? "Preparing…" : "Excel"}</button>
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}

/** Export buttons for the custom report builder's current query. */
export function CustomReportExport({ outletId, input }: { outletId: string; input: CustomReportInput }) {
  const can = useCan("reports.export");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can) return null;
  const go = async (format: ExportFormat) => {
    setBusy(true);
    setError(null);
    try {
      await platformApi.exportCustom(outletId, input, format);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn-ghost sm" disabled={busy} onClick={() => void go("csv")}>CSV</button>
      <button className="btn-ghost sm" disabled={busy} onClick={() => void go("xlsx")}>Excel</button>
      {error && <span className="cr-error">{error}</span>}
    </>
  );
}

const blank = (): ReportScheduleInput => ({
  name: "Daily summary",
  frequency: "DAILY",
  weekday: null,
  hour: 8,
  recipients: [],
  reports: ["overview", "payments", "top-items", "day-end"],
  format: "XLSX",
  isActive: true,
});

/** Daily/weekly report emails for this outlet. */
export function ReportSchedules({ outletId }: { outletId: string }) {
  const can = useCan("reports.schedule");
  const [list, setList] = useState<ReportScheduleDto[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: ReportScheduleInput; recipients: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await platformApi.schedules(outletId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load schedules");
    }
  }, [outletId]);

  useEffect(() => {
    if (can) void load();
  }, [can, load]);

  if (!can) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    editing &&
    run(async () => {
      const input: ReportScheduleInput = {
        ...editing.input,
        recipients: editing.recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
        weekday: editing.input.frequency === "WEEKLY" ? (editing.input.weekday ?? 1) : null,
      };
      if (editing.id) await platformApi.updateSchedule(outletId, editing.id, input);
      else await platformApi.createSchedule(outletId, input);
      setEditing(null);
    });

  const edit = (s: ReportScheduleDto) =>
    setEditing({
      id: s.id,
      recipients: s.recipients.join(", "),
      input: { name: s.name, frequency: s.frequency, weekday: s.weekday, hour: s.hour, recipients: s.recipients, reports: s.reports, format: s.format, isActive: s.isActive },
    });

  const describe = (s: ReportScheduleDto) =>
    `${s.frequency === "DAILY" ? "Every day" : `Every ${WEEKDAYS[s.weekday ?? 1]}`} at ${String(s.hour).padStart(2, "0")}:00 · ${s.format}`;

  return (
    <div className="report-card pf-stack">
      <div className="pf-row between">
        <span className="card-title" style={{ margin: 0 }}>Scheduled email reports</span>
        {!editing && <button className="btn-ghost sm" onClick={() => setEditing({ id: null, input: blank(), recipients: "" })}>+ New schedule</button>}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="pf-list">
        {list.map((s) => (
          <div key={s.id} className="pf-item">
            <div className="pf-item-main">
              <span className="pf-item-title">{s.name} {!s.isActive && <span className="status-pill muted">paused</span>}</span>
              <span className="pf-item-sub">{describe(s)} · to {s.recipients.join(", ")}</span>
              <span className="pf-item-sub">
                Next {new Date(s.nextRunAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                {s.lastRunAt && ` · last ${s.lastStatus === "SENT" ? "sent" : "failed"} ${new Date(s.lastRunAt).toLocaleDateString("en-IN")}`}
                {s.lastError && ` (${s.lastError})`}
              </span>
            </div>
            <button className="text-btn" disabled={busy} onClick={() => void run(async () => void (await platformApi.sendScheduleNow(outletId, s.id)))}>Send now</button>
            <button className="text-btn" onClick={() => edit(s)}>Edit</button>
            <button className="text-btn danger" disabled={busy} onClick={() => void run(async () => void (await platformApi.deleteSchedule(outletId, s.id)))}>Delete</button>
          </div>
        ))}
        {list.length === 0 && !editing && <p className="empty pf-item">No scheduled reports. Daily runs cover yesterday; weekly runs cover the 7 days before.</p>}
      </div>

      {editing && (
        <div className="pf-stack">
          <div className="pf-row">
            <label className="pf-label">Name<input value={editing.input.name} maxLength={80} onChange={(e) => setEditing({ ...editing, input: { ...editing.input, name: e.target.value } })} /></label>
            <label className="pf-label">Frequency
              <select value={editing.input.frequency} onChange={(e) => setEditing({ ...editing, input: { ...editing.input, frequency: e.target.value as "DAILY" | "WEEKLY" } })}>
                <option value="DAILY">Daily (yesterday)</option>
                <option value="WEEKLY">Weekly (last 7 days)</option>
              </select>
            </label>
            {editing.input.frequency === "WEEKLY" && (
              <label className="pf-label">On
                <select value={editing.input.weekday ?? 1} onChange={(e) => setEditing({ ...editing, input: { ...editing.input, weekday: Number(e.target.value) } })}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </label>
            )}
            <label className="pf-label">At
              <select value={editing.input.hour} onChange={(e) => setEditing({ ...editing, input: { ...editing.input, hour: Number(e.target.value) } })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </select>
            </label>
            <label className="pf-label">Format
              <select value={editing.input.format} onChange={(e) => setEditing({ ...editing, input: { ...editing.input, format: e.target.value as "CSV" | "XLSX" } })}>
                <option value="XLSX">Excel</option>
                <option value="CSV">CSV</option>
              </select>
            </label>
          </div>
          <label className="pf-label">Recipients (comma separated)
            <input value={editing.recipients} onChange={(e) => setEditing({ ...editing, recipients: e.target.value })} placeholder="owner@example.com, accounts@example.com" />
          </label>
          <span className="pf-label">Reports</span>
          <div className="pf-chips">
            {REPORT_EXPORTS.map((r) => {
              const on = editing.input.reports.includes(r.key);
              return (
                <button key={r.key} type="button" className={`pf-toggle-chip ${on ? "on" : ""}`}
                  onClick={() => setEditing({ ...editing, input: { ...editing.input, reports: on ? editing.input.reports.filter((k) => k !== r.key) : [...editing.input.reports, r.key] } })}>
                  {r.label}
                </button>
              );
            })}
          </div>
          <label className="pf-switch">
            <input type="checkbox" checked={editing.input.isActive} onChange={(e) => setEditing({ ...editing, input: { ...editing.input, isActive: e.target.checked } })} />
            Active
          </label>
          <div className="pf-row end">
            <button className="text-btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn-primary sm" disabled={busy || !editing.input.name.trim() || !editing.recipients.trim() || editing.input.reports.length === 0} onClick={() => void save()}>
              Save schedule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
