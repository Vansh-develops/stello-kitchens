"use client";

import { useCallback, useEffect, useState } from "react";
import type { DeviceDto, DeviceType } from "@petpooja/shared";
import { api } from "@/lib/api";

const TYPES: { key: DeviceType; label: string }[] = [
  { key: "POS", label: "POS" },
  { key: "KDS", label: "KDS" },
  { key: "PRINTER", label: "Printer" },
  { key: "KIOSK", label: "Kiosk" },
  { key: "DISPLAY", label: "Display" },
];

const isOnline = (lastSeenAt: string | null) =>
  !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 120_000;

export function FleetTab({ outletId }: { outletId: string }) {
  const [devices, setDevices] = useState<DeviceDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<DeviceType>("POS");

  const reload = useCallback(async () => {
    try {
      setDevices(await api.devices(outletId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load devices");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      await reload();
      if (ok) setMessage(ok);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const register = () =>
    run(async () => {
      if (!newName.trim()) throw new Error("Name the device");
      await api.deviceCreate(outletId, { name: newName.trim(), type: newType });
      setNewName("");
    }, "Device registered");

  const downloadBackup = async () => {
    try {
      const backup = await api.deviceBackup(outletId);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `spice-route-backup-${backup.generatedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage(
        `Backup downloaded · ${backup.counts.items} items, ${backup.counts.tables} tables, ${backup.counts.devices} devices`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    }
  };

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Device fleet</h1>
        <button className="btn-ghost sm" onClick={downloadBackup}>
          ↓ Download config backup
        </button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {message && <div className="banner-ok" onClick={() => setMessage(null)}>{message}</div>}
      <p className="hint wide">
        Register and configure every device in the outlet — POS counters, KDS screens, and receipt
        printers. Printer and KDS settings push to the device; the backup exports the outlet&apos;s
        menu, tables, and fleet config as a JSON file.
      </p>

      <div className="fleet-new">
        <input placeholder="Device name (e.g. Counter 2)" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <select value={newType} onChange={(e) => setNewType(e.target.value as DeviceType)}>
          {TYPES.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>
        <button className="btn-primary sm" onClick={register}>Register device</button>
      </div>

      <div className="fleet-list">
        {devices.map((d) => (
          <DeviceCard
            key={d.id}
            device={d}
            onToggleActive={() => run(() => api.deviceUpdate(outletId, d.id, { isActive: !d.isActive }))}
            onSaveConfig={(config) => run(() => api.deviceUpdate(outletId, d.id, { config }), "Config saved")}
            onPing={() => run(() => api.deviceHeartbeat(d.deviceToken), `${d.name} pinged`)}
            onDelete={() => run(() => api.deviceDelete(outletId, d.id))}
          />
        ))}
        {devices.length === 0 && <p className="empty">No devices yet. Register one above.</p>}
      </div>
    </div>
  );
}

function DeviceCard({
  device,
  onToggleActive,
  onSaveConfig,
  onPing,
  onDelete,
}: {
  device: DeviceDto;
  onToggleActive: () => void;
  onSaveConfig: (config: Record<string, unknown>) => void;
  onPing: () => void;
  onDelete: () => void;
}) {
  const [cfg, setCfg] = useState<Record<string, unknown>>(device.config);
  const online = isOnline(device.lastSeenAt);
  const set = (k: string, v: unknown) => setCfg((p) => ({ ...p, [k]: v }));

  return (
    <div className={`device-card ${device.isActive ? "" : "inactive"}`}>
      <div className="dc-head">
        <div className="dc-title">
          <span className={`dc-dot ${online ? "on" : "off"}`} title={online ? "Online" : "Offline"} />
          <span className="dc-name">{device.name}</span>
          <span className={`type-badge t-${device.type.toLowerCase()}`}>{device.type}</span>
        </div>
        <span className="dc-seen">
          {device.lastSeenAt ? `seen ${new Date(device.lastSeenAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : "never seen"}
        </span>
      </div>

      {device.type === "PRINTER" && (
        <div className="dc-config">
          <label>
            Paper
            <select value={String(cfg.paperWidth ?? "80mm")} onChange={(e) => set("paperWidth", e.target.value)}>
              <option value="58mm">58mm</option>
              <option value="80mm">80mm</option>
            </select>
          </label>
          <label className="chk">
            <input type="checkbox" checked={!!cfg.autoPrintKot} onChange={(e) => set("autoPrintKot", e.target.checked)} /> Auto-print KOT
          </label>
          <label className="chk">
            <input type="checkbox" checked={!!cfg.autoPrintBill} onChange={(e) => set("autoPrintBill", e.target.checked)} /> Auto-print bill
          </label>
          <label>
            Copies
            <input type="number" min={1} max={5} value={Number(cfg.copies ?? 1)} onChange={(e) => set("copies", Number(e.target.value))} />
          </label>
        </div>
      )}

      {device.type === "KDS" && (
        <div className="dc-config">
          <label>
            Theme
            <select value={String(cfg.theme ?? "dark")} onChange={(e) => set("theme", e.target.value)}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="contrast">High contrast</option>
            </select>
          </label>
          <label>
            Density
            <select value={String(cfg.density ?? "comfortable")} onChange={(e) => set("density", e.target.value)}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
          <label>
            Columns
            <input type="number" min={1} max={6} value={Number(cfg.columns ?? 3)} onChange={(e) => set("columns", Number(e.target.value))} />
          </label>
          <label className="chk">
            <input type="checkbox" checked={!!cfg.sound} onChange={(e) => set("sound", e.target.checked)} /> Alert sound
          </label>
        </div>
      )}

      {device.type !== "PRINTER" && device.type !== "KDS" && (
        <p className="dc-noconfig">No device-specific settings.</p>
      )}

      <div className="dc-foot">
        <button className={`stock-toggle ${device.isActive ? "in" : "out"}`} onClick={onToggleActive}>
          {device.isActive ? "Active" : "Disabled"}
        </button>
        <div className="dc-actions">
          <button className="text-btn" onClick={onPing}>Ping</button>
          {(device.type === "PRINTER" || device.type === "KDS") && (
            <button className="btn-primary sm" onClick={() => onSaveConfig(cfg)}>Save config</button>
          )}
          <button className="text-btn danger" onClick={onDelete}>Remove</button>
        </div>
      </div>
    </div>
  );
}
