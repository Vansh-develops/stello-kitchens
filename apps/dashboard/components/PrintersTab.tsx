"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CODEPAGES,
  type Codepage,
  type CreatePrinterInput,
  type PrintJobDto,
  type PrintSettingsDto,
  type PrinterConnection,
  type PrinterDto,
  type StationDto,
} from "@stello/shared";
import { printApi } from "@/lib/print-api";
import { kdsApi } from "@/lib/kds-api";
import { usePrintStation } from "@/lib/print/station";
import { StationSettings } from "./printing/StationSettings";
import "./printing/printing.css";

const CONNECTIONS: { key: PrinterConnection; label: string; hint: string }[] = [
  { key: "NETWORK", label: "Network (LAN)", hint: "Ethernet/Wi-Fi printer on port 9100, driven by the edge print agent." },
  { key: "USB", label: "USB", hint: "Printer cable-connected to the machine running the edge print agent." },
  { key: "BROWSER", label: "Browser", hint: "Prints through the POS/KDS browser's print dialog. No install." },
];

const STATUS_PILL: Record<string, string> = { PRINTED: "ok", FAILED: "bad", QUEUED: "warn", PRINTING: "warn", CANCELLED: "" };

const blank: CreatePrinterInput = {
  name: "",
  connection: "NETWORK",
  host: "",
  port: 9100,
  usbPath: "",
  paperWidth: 80,
  codepage: "CP437",
  printKots: true,
  printBills: false,
  stationIds: [],
  copies: 1,
  autoPrintKot: true,
  autoPrintBill: true,
  drawerKick: false,
  isActive: true,
};

function describe(p: PrinterDto, stations: StationDto[]) {
  const where = p.connection === "NETWORK" ? `${p.host}:${p.port}` : p.connection === "USB" ? p.usbPath : "browser print";
  const roles = [p.printBills && "bills", p.printKots && "KOTs"].filter(Boolean).join(" + ") || "no documents";
  const st = p.printKots
    ? p.stationIds.length
      ? stations.filter((s) => p.stationIds.includes(s.id)).map((s) => s.name).join(", ")
      : "all stations"
    : null;
  return `${where} · ${p.paperWidth}mm · ${roles}${st ? ` (${st})` : ""}`;
}

export function PrintersTab({ outletId }: { outletId: string }) {
  const [printers, setPrinters] = useState<PrinterDto[]>([]);
  const [stations, setStations] = useState<StationDto[]>([]);
  const [settings, setSettings] = useState<PrintSettingsDto | null>(null);
  const [jobs, setJobs] = useState<PrintJobDto[]>([]);
  const [jobFilter, setJobFilter] = useState<string>("");
  const [editing, setEditing] = useState<{ id: string | null; form: CreatePrinterInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // This console is a print station too, so "test print" works from here.
  const station = usePrintStation(outletId);

  const reload = useCallback(async () => {
    try {
      const [p, s, j] = await Promise.all([printApi.printers(outletId), printApi.settings(outletId), printApi.jobs(outletId, jobFilter || undefined)]);
      setPrinters(p);
      setSettings(s);
      setJobs(j);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load printers");
    }
  }, [outletId, jobFilter]);

  useEffect(() => {
    void reload();
    void kdsApi.stations(outletId).then(setStations).catch(() => setStations([]));
  }, [outletId, reload]);

  // Keep the job log live-ish while the tab is open.
  useEffect(() => {
    const id = setInterval(() => void printApi.jobs(outletId, jobFilter || undefined).then(setJobs).catch(() => undefined), 5000);
    return () => clearInterval(id);
  }, [outletId, jobFilter]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      await reload();
      await station.reloadPrinters();
      if (ok) setMessage(ok);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const save = () =>
    run(async () => {
      if (!editing) return;
      const f = editing.form;
      if (!f.name.trim()) throw new Error("Name the printer");
      if (!f.printKots && !f.printBills && !f.drawerKick) throw new Error("Pick what this printer is for (bills, KOTs or cash drawer)");
      const input: CreatePrinterInput = {
        ...f,
        name: f.name.trim(),
        host: f.connection === "NETWORK" ? f.host?.trim() || null : null,
        usbPath: f.connection === "USB" ? f.usbPath?.trim() || null : null,
      };
      if (editing.id) await printApi.updatePrinter(outletId, editing.id, input);
      else await printApi.createPrinter(outletId, input);
      setEditing(null);
    }, editing?.id ? "Printer saved" : "Printer added");

  const testPrint = (p: PrinterDto) =>
    run(async () => {
      await printApi.testPrint(outletId, p.id);
      station.kick();
    }, `Test page sent to ${p.name}`);

  const set = <K extends keyof CreatePrinterInput>(k: K, v: CreatePrinterInput[K]) =>
    setEditing((e) => (e ? { ...e, form: { ...e.form, [k]: v } } : e));

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Printers</h1>
        <button className="btn-primary sm" onClick={() => setEditing({ id: null, form: { ...blank } })}>
          + Add printer
        </button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {message && <div className="banner-ok" onClick={() => setMessage(null)}>{message}</div>}
      <p className="hint wide">
        Route kitchen tickets to station printers and bills to the counter. Stello is in the cloud, so LAN and USB
        printers are driven by the edge print agent at the outlet; browser printers print from the POS/KDS screen.
      </p>

      <div className="prn-tab">
        <div className="prn-panel">
          <div className="prn-card">
            <h2>Outlet printers</h2>
            <div className="prn-list">
              {printers.map((p) => (
                <div key={p.id} className="prn-item">
                  <div className="prn-item-main">
                    <span className="prn-item-title">
                      {p.name} {!p.isActive && <span className="prn-pill">disabled</span>}
                    </span>
                    <span className="prn-item-meta">{describe(p, stations)}</span>
                    <span className="prn-item-meta">
                      {[p.autoPrintKot && p.printKots && "auto KOT", p.autoPrintBill && p.printBills && "auto bill", p.drawerKick && "cash drawer", p.copies > 1 && `${p.copies} copies`]
                        .filter(Boolean)
                        .join(" · ") || "manual only"}
                    </span>
                  </div>
                  <div className="prn-item-actions">
                    <button className="prn-btn sm" onClick={() => testPrint(p)} disabled={!p.isActive}>
                      Test print
                    </button>
                    <button className="prn-btn sm" onClick={() => setEditing({ id: p.id, form: { ...p } })}>
                      Edit
                    </button>
                    <button
                      className="prn-btn sm danger"
                      onClick={() => confirm(`Remove ${p.name}?`) && run(() => printApi.deletePrinter(outletId, p.id), "Printer removed")}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {printers.length === 0 && <div className="prn-empty">No printers yet. Add your counter and kitchen printers.</div>}
            </div>

            {editing && (
              <div className="prn-editor">
                <h2>{editing.id ? "Edit printer" : "New printer"}</h2>
                <div className="prn-field-grid">
                  <label className="prn-field">
                    <span>Name</span>
                    <input value={editing.form.name} placeholder="e.g. Tandoor KOT" onChange={(e) => set("name", e.target.value)} />
                  </label>
                  <label className="prn-field">
                    <span>Connection</span>
                    <select value={editing.form.connection} onChange={(e) => set("connection", e.target.value as PrinterConnection)}>
                      {CONNECTIONS.map((c) => (
                        <option key={c.key} value={c.key}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                  {editing.form.connection === "NETWORK" && (
                    <>
                      <label className="prn-field">
                        <span>IP address / host</span>
                        <input value={editing.form.host ?? ""} placeholder="192.168.1.50" onChange={(e) => set("host", e.target.value)} />
                      </label>
                      <label className="prn-field">
                        <span>Port</span>
                        <input type="number" value={editing.form.port ?? 9100} onChange={(e) => set("port", Number(e.target.value))} />
                      </label>
                    </>
                  )}
                  {editing.form.connection === "USB" && (
                    <label className="prn-field">
                      <span>Device path on the agent</span>
                      <input value={editing.form.usbPath ?? ""} placeholder="\\localhost\POS80 or /dev/usb/lp0" onChange={(e) => set("usbPath", e.target.value)} />
                    </label>
                  )}
                  <label className="prn-field">
                    <span>Paper</span>
                    <select value={editing.form.paperWidth} onChange={(e) => set("paperWidth", Number(e.target.value) as 58 | 80)}>
                      <option value={80}>80 mm (48 columns)</option>
                      <option value={58}>58 mm (32 columns)</option>
                    </select>
                  </label>
                  {editing.form.connection !== "BROWSER" && (
                    <label className="prn-field">
                      <span>Code page</span>
                      <select value={editing.form.codepage} onChange={(e) => set("codepage", e.target.value as Codepage)}>
                        {CODEPAGES.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="prn-field">
                    <span>Copies</span>
                    <input type="number" min={1} max={5} value={editing.form.copies ?? 1} onChange={(e) => set("copies", Number(e.target.value))} />
                  </label>
                </div>
                <p className="prn-hint">{CONNECTIONS.find((c) => c.key === editing.form.connection)?.hint}</p>

                <div className="prn-sub">Prints</div>
                <div className="prn-row">
                  <label className="prn-check">
                    <input type="checkbox" checked={!!editing.form.printBills} onChange={(e) => set("printBills", e.target.checked)} /> Bills
                  </label>
                  <label className="prn-check">
                    <input type="checkbox" checked={!!editing.form.printKots} onChange={(e) => set("printKots", e.target.checked)} /> KOTs
                  </label>
                  {editing.form.connection !== "BROWSER" && (
                    <label className="prn-check">
                      <input type="checkbox" checked={!!editing.form.drawerKick} onChange={(e) => set("drawerKick", e.target.checked)} /> Cash drawer
                      attached (opens on cash settle)
                    </label>
                  )}
                </div>

                {editing.form.printKots && (
                  <>
                    <div className="prn-sub">Kitchen stations (none selected = every station)</div>
                    <div className="prn-chips">
                      {stations.map((s) => {
                        const on = editing.form.stationIds?.includes(s.id);
                        return (
                          <button
                            type="button"
                            key={s.id}
                            className={`prn-chip ${on ? "on" : ""}`}
                            onClick={() =>
                              set("stationIds", on ? editing.form.stationIds!.filter((x) => x !== s.id) : [...(editing.form.stationIds ?? []), s.id])
                            }
                          >
                            {s.name}
                          </button>
                        );
                      })}
                      {stations.length === 0 && <span className="prn-hint">No stations defined.</span>}
                    </div>
                  </>
                )}

                <div className="prn-sub">Automatic printing</div>
                <div className="prn-row">
                  {editing.form.printKots && (
                    <label className="prn-check">
                      <input type="checkbox" checked={!!editing.form.autoPrintKot} onChange={(e) => set("autoPrintKot", e.target.checked)} /> KOT on
                      punch
                    </label>
                  )}
                  {editing.form.printBills && (
                    <label className="prn-check">
                      <input type="checkbox" checked={!!editing.form.autoPrintBill} onChange={(e) => set("autoPrintBill", e.target.checked)} /> Bill on
                      settle
                    </label>
                  )}
                  <label className="prn-check">
                    <input type="checkbox" checked={editing.form.isActive !== false} onChange={(e) => set("isActive", e.target.checked)} /> Enabled
                  </label>
                </div>
                <div className="prn-row end">
                  <button className="prn-btn" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="prn-btn primary" onClick={save}>Save printer</button>
                </div>
              </div>
            )}
          </div>

          <div className="prn-card">
            <div className="prn-row between">
              <h2>Print jobs</h2>
              <select className="prn-btn sm" value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
                <option value="">All recent</option>
                <option value="FAILED">Failed</option>
                <option value="QUEUED">Waiting</option>
                <option value="PRINTED">Printed</option>
              </select>
            </div>
            <div className="prn-list">
              {jobs.map((j) => (
                <div key={j.id} className="prn-item">
                  <div className="prn-item-main">
                    <span className="prn-item-title">
                      {jobTitle(j)} <span className={`prn-pill ${STATUS_PILL[j.status] ?? ""}`}>{j.status.toLowerCase()}</span>
                    </span>
                    <span className="prn-item-meta">
                      {j.printerName ?? "removed printer"} · {new Date(j.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                      {j.attempts > 1 ? ` · ${j.attempts} attempts` : ""}
                    </span>
                    {j.error && <span className="prn-item-meta">⚠ {j.error}</span>}
                  </div>
                  <div className="prn-item-actions">
                    {(j.status === "FAILED" || j.status === "CANCELLED") && (
                      <button className="prn-btn sm" onClick={() => run(() => printApi.retry(j.id), "Re-queued").then(station.kick)}>
                        Retry
                      </button>
                    )}
                    {(j.status === "QUEUED" || j.status === "FAILED") && (
                      <button className="prn-btn sm" onClick={() => run(() => printApi.cancel(j.id))}>Cancel</button>
                    )}
                    {j.status === "PRINTED" && j.kind !== "DRAWER" && (
                      <button className="prn-btn sm" onClick={() => run(() => printApi.reprint(j.id), "Reprint queued").then(station.kick)}>
                        Reprint
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {jobs.length === 0 && <div className="prn-empty">No print jobs.</div>}
            </div>
          </div>
        </div>

        <div className="prn-panel">
          {settings && <BillSettingsCard outletId={outletId} settings={settings} onSaved={(s) => { setSettings(s); setMessage("Bill details saved"); }} onError={setError} />}
          <div className="prn-card">
            <h2>Printing on this device</h2>
            <StationSettings outletId={outletId} printers={printers} />
            {station.lastError && <span className="prn-pill bad">{station.lastError}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function jobTitle(j: PrintJobDto): string {
  const p = j.payload;
  const re = j.reprint ? " (reprint)" : "";
  if (p.kind === "KOT") return `${p.ticket.cancelled ? "Cancel " : ""}KOT #${p.ticket.kotNumber}${p.ticket.tableName ? ` · ${p.ticket.tableName}` : ""}${re}`;
  if (p.kind === "BILL") return `${p.bill.provisional ? "Pre-bill" : `Bill ${p.bill.billNumber}`}${re}`;
  if (p.kind === "TEST") return "Test page";
  return "Open cash drawer";
}

function BillSettingsCard({
  outletId,
  settings,
  onSaved,
  onError,
}: {
  outletId: string;
  settings: PrintSettingsDto;
  onSaved: (s: PrintSettingsDto) => void;
  onError: (m: string) => void;
}) {
  const [fssai, setFssai] = useState(settings.fssaiNumber ?? "");
  const [header, setHeader] = useState(settings.headerLines.join("\n"));
  const [footer, setFooter] = useState(settings.footerLines.join("\n"));
  const [upiQr, setUpiQr] = useState(settings.upiQrOnBill);

  const save = async () => {
    try {
      onSaved(
        await printApi.updateSettings(outletId, {
          fssaiNumber: fssai.trim() || null,
          headerLines: header.split("\n").slice(0, 4),
          footerLines: footer.split("\n").slice(0, 4),
          upiQrOnBill: upiQr,
        }),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save");
    }
  };

  return (
    <div className="prn-card">
      <h2>Bill details</h2>
      <p className="prn-hint">Brand, outlet name, address and GSTIN come from the outlet profile.</p>
      <label className="prn-field">
        <span>FSSAI licence number</span>
        <input value={fssai} inputMode="numeric" maxLength={14} placeholder="14 digits" onChange={(e) => setFssai(e.target.value.replace(/\D/g, ""))} />
      </label>
      <label className="prn-field">
        <span>Extra header lines (up to 4)</span>
        <textarea value={header} placeholder="Phone: 080 1234 5678" onChange={(e) => setHeader(e.target.value)} />
      </label>
      <label className="prn-field">
        <span>Footer lines (up to 4)</span>
        <textarea value={footer} onChange={(e) => setFooter(e.target.value)} />
      </label>
      <label className="prn-check">
        <input type="checkbox" checked={upiQr} onChange={(e) => setUpiQr(e.target.checked)} /> Scan-to-pay UPI QR on pre-bills
      </label>
      <div className="prn-row end">
        <button className="prn-btn primary" onClick={save}>Save bill details</button>
      </div>
    </div>
  );
}
