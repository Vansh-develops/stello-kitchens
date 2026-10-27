"use client";

import { useEffect, useState } from "react";
import type { PrinterDto } from "@stello/shared";
import { loadStationConfig, probeAgent, saveStationConfig, type StationConfig } from "@/lib/print/station";
import "./printing.css";

const CONNECTION_LABEL = { NETWORK: "LAN", USB: "USB", BROWSER: "Browser" } as const;

/**
 * "Printing on this device" — per-terminal settings (stored in this browser):
 * the local print agent and which printers this terminal is responsible for.
 */
export function StationSettings({ outletId, printers }: { outletId: string; printers: PrinterDto[] }) {
  const [cfg, setCfg] = useState<StationConfig>(() => loadStationConfig(outletId));
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setCfg(loadStationConfig(outletId)), [outletId]);

  const set = <K extends keyof StationConfig>(k: K, v: StationConfig[K]) => {
    setSaved(false);
    setCfg((c) => ({ ...c, [k]: v }));
  };
  const toggle = (id: string) =>
    set("printerIds", cfg.printerIds.includes(id) ? cfg.printerIds.filter((x) => x !== id) : [...cfg.printerIds, id]);

  const test = async () => setStatus(await probeAgent(cfg));
  const save = () => {
    saveStationConfig(outletId, { ...cfg, agentUrl: cfg.agentUrl.trim().replace(/\/$/, "") });
    setSaved(true);
  };

  return (
    <div className="prn-station">
      <div className="prn-field-grid">
        <label className="prn-field">
          <span>Print agent URL</span>
          <input
            placeholder="http://127.0.0.1:4010"
            value={cfg.agentUrl}
            onChange={(e) => set("agentUrl", e.target.value)}
          />
        </label>
        <label className="prn-field">
          <span>Agent key</span>
          <input type="password" value={cfg.agentKey} onChange={(e) => set("agentKey", e.target.value)} />
        </label>
      </div>
      <div className="prn-row">
        <button type="button" className="prn-btn" onClick={test} disabled={!cfg.agentUrl}>
          Test connection
        </button>
        {status && <span className={`prn-pill ${status.ok ? "ok" : "bad"}`}>{status.message}</span>}
      </div>
      <p className="prn-hint">
        The edge print agent sends ESC/POS straight to LAN/USB printers and opens the cash drawer. Without it,
        tickets print through this browser&apos;s print dialog.
      </p>

      <label className="prn-check">
        <input type="checkbox" checked={cfg.printOwn} onChange={(e) => set("printOwn", e.target.checked)} />
        Print what I punch here (KOTs, bills, reprints)
      </label>

      <div className="prn-sub">This device also prints everything for:</div>
      <div className="prn-chips">
        {printers.filter((p) => p.isActive).map((p) => (
          <button
            type="button"
            key={p.id}
            className={`prn-chip ${cfg.printerIds.includes(p.id) ? "on" : ""}`}
            onClick={() => toggle(p.id)}
            title="Includes Scan & Order and online-order KOTs"
          >
            {p.name} <small>{CONNECTION_LABEL[p.connection]}</small>
          </button>
        ))}
        {printers.length === 0 && <span className="prn-hint">No printers set up for this outlet yet.</span>}
      </div>

      <label className="prn-field inline">
        <span>Step in for LAN tickets no agent printed after</span>
        <select value={cfg.fallbackAfterSec} onChange={(e) => set("fallbackAfterSec", Number(e.target.value))}>
          <option value={0}>Never</option>
          <option value={10}>10 s</option>
          <option value={20}>20 s</option>
          <option value={60}>1 min</option>
        </select>
      </label>

      <div className="prn-row end">
        {saved && <span className="prn-pill ok">Saved on this device</span>}
        <button type="button" className="prn-btn primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
