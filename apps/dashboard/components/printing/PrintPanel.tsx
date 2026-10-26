"use client";

import { useCallback, useEffect, useState } from "react";
import type { PrintJobDto, RecentBillDto } from "@stello/shared";
import { printApi } from "@/lib/print-api";
import { printBillNow } from "@/lib/print/actions";
import type { PrintStation } from "@/lib/print/station";
import { StationSettings } from "./StationSettings";
import "./printing.css";

type View = "bills" | "queue" | "device";

/** POS/KDS print centre: bill history with reprint, stuck jobs, drawer, device setup. */
export function PrintPanel({
  outletId,
  station,
  onClose,
  showBills = true,
}: {
  outletId: string;
  station: PrintStation;
  onClose: () => void;
  showBills?: boolean;
}) {
  const [view, setView] = useState<View>(showBills ? "bills" : "queue");
  const [bills, setBills] = useState<RecentBillDto[]>([]);
  const [jobs, setJobs] = useState<PrintJobDto[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, f, q] = await Promise.all([
        showBills ? printApi.recentBills(outletId) : Promise.resolve([]),
        printApi.jobs(outletId, "FAILED"),
        printApi.jobs(outletId, "QUEUED"),
      ]);
      setBills(b);
      setJobs([...f, ...q]);
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : "Could not load" });
    }
  }, [outletId, showBills]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      station.kick();
      setNote({ ok: true, text: ok });
      await load();
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : "Print failed" });
    } finally {
      setBusy(null);
    }
  };

  const drawerPrinter = station.printers.some((p) => p.isActive && p.drawerKick);

  return (
    <div className="prn-scrim" onClick={onClose}>
      <div className="prn-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Printing">
        <header className="prn-modal-head">
          <h2>Printing</h2>
          <div className="prn-row">
            <span className={`prn-pill ${station.config.agentUrl ? (station.agentOk ? "ok" : "bad") : ""}`}>
              {station.config.agentUrl ? (station.agentOk ? "Agent connected" : "Agent offline") : "Browser printing"}
            </span>
            <button className="prn-btn sm" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>
        <div className="prn-modal-body">
          <div className="prn-tabs">
            {showBills && (
              <button className={`prn-chip ${view === "bills" ? "on" : ""}`} onClick={() => setView("bills")}>
                Recent bills
              </button>
            )}
            <button className={`prn-chip ${view === "queue" ? "on" : ""}`} onClick={() => setView("queue")}>
              Queue {jobs.length > 0 && `(${jobs.length})`}
            </button>
            <button className={`prn-chip ${view === "device" ? "on" : ""}`} onClick={() => setView("device")}>
              This device
            </button>
          </div>
          {note && <span className={`prn-pill ${note.ok ? "ok" : "bad"}`}>{note.text}</span>}
          {station.lastError && <span className="prn-pill bad">{station.lastError}</span>}

          {view === "bills" && (
            <>
              <div className="prn-list">
                {bills.map((b) => (
                  <div key={b.orderId} className="prn-item">
                    <div className="prn-item-main">
                      <span className="prn-item-title">{b.billNumber ?? "—"} · ₹{b.total.toFixed(2)}</span>
                      <span className="prn-item-meta">
                        {b.tableName ?? b.orderType.replace("_", " ").toLowerCase()} ·{" "}
                        {new Date(b.settledAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <button
                      className="prn-btn sm"
                      disabled={busy === b.orderId}
                      onClick={() => act(b.orderId, () => printBillNow(outletId, b.orderId, station), `Reprinting ${b.billNumber}`)}
                    >
                      {busy === b.orderId ? "…" : "Reprint"}
                    </button>
                  </div>
                ))}
                {bills.length === 0 && <div className="prn-empty">No settled bills yet.</div>}
              </div>
              {drawerPrinter && (
                <div className="prn-row end">
                  <button className="prn-btn" disabled={busy === "drawer"} onClick={() => act("drawer", () => printApi.kickDrawer(outletId), "Drawer opening")}>
                    Open cash drawer
                  </button>
                </div>
              )}
            </>
          )}

          {view === "queue" && (
            <div className="prn-list">
              {jobs.map((j) => (
                <div key={j.id} className="prn-item">
                  <div className="prn-item-main">
                    <span className="prn-item-title">
                      {j.kind === "KOT" && j.payload.kind === "KOT" ? `KOT #${j.payload.ticket.kotNumber}` : j.kind.toLowerCase()} ·{" "}
                      {j.printerName ?? "removed printer"}{" "}
                      <span className={`prn-pill ${j.status === "FAILED" ? "bad" : "warn"}`}>{j.status.toLowerCase()}</span>
                    </span>
                    {j.error && <span className="prn-item-meta">{j.error}</span>}
                  </div>
                  <div className="prn-item-actions">
                    {j.status === "FAILED" && (
                      <button className="prn-btn sm" onClick={() => act(j.id, () => printApi.retry(j.id), "Retrying")}>
                        Retry
                      </button>
                    )}
                    <button className="prn-btn sm" onClick={() => act(j.id, () => printApi.cancel(j.id), "Cancelled")}>
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
              {jobs.length === 0 && <div className="prn-empty">Nothing waiting. All tickets printed.</div>}
            </div>
          )}

          {view === "device" && <StationSettings outletId={outletId} printers={station.printers} />}
        </div>
      </div>
    </div>
  );
}
