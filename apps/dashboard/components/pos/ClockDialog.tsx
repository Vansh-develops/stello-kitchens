"use client";

import { useCallback, useEffect, useState } from "react";
import "../hr/hr.css";
import type { ClockActionInput, ClockStaffDto } from "@stello/shared";
import { hrApi, timeIst } from "@/lib/hr-api";

const STATE_LABEL: Record<ClockStaffDto["status"], string> = { IN: "On shift", ON_BREAK: "On break", OUT: "Clocked out" };

/** POS time clock: staff tap their name, enter their PIN, then clock in/out or take a break. */
export function ClockDialog({ outletId, onClose }: { outletId: string; onClose: () => void }) {
  const [board, setBoard] = useState<ClockStaffDto[]>([]);
  const [picked, setPicked] = useState<ClockStaffDto | null>(null);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setBoard(await hrApi.clockBoard(outletId));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not load staff" });
    }
  }, [outletId]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: ClockActionInput["action"]) => {
    if (!picked) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await hrApi.clock(outletId, { staffId: picked.id, pin, action });
      const verb = { IN: "clocked in", OUT: "clocked out", BREAK_START: "started a break", BREAK_END: "is back from break" }[action];
      setMsg({ ok: true, text: `${res.name} ${verb} at ${timeIst(new Date().toISOString())}` });
      setPicked(null);
      setPin("");
      await load();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Clock action failed" });
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  const press = (k: string) => {
    if (k === "⌫") setPin((p) => p.slice(0, -1));
    else if (k === "C") setPin("");
    else setPin((p) => (p.length < 6 ? p + k : p));
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <header className="modal-head">
          <div>
            <h2>Time clock</h2>
            <span className="settle-sub">Tap your name, enter your PIN</span>
          </div>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          {msg && <p className={msg.ok ? "form-success" : "form-error"}>{msg.text}</p>}
          {!picked ? (
            <div className="clock-grid">
              {board.map((s) => (
                <button key={s.id} className="clock-card" onClick={() => { setPicked(s); setPin(""); setMsg(null); }}>
                  <strong>{s.name}</strong>
                  {s.designation && <em>{s.designation}</em>}
                  <span className={`clock-state ${s.status}`}>
                    {STATE_LABEL[s.status]}{s.since ? ` · ${timeIst(s.since)}` : ""}
                  </span>
                </button>
              ))}
              {board.length === 0 && <p className="hint">No staff with a clock-in PIN at this outlet. A manager can set PINs under Console → Staff.</p>}
            </div>
          ) : (
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div>
                <p style={{ margin: "0 0 6px" }}>
                  <strong>{picked.name}</strong> · <span className={`clock-state ${picked.status}`}>{STATE_LABEL[picked.status]}</span>
                </p>
                <div className="pin-dots mono">{pin.replace(/./g, "●") || <span className="faint">PIN</span>}</div>
                <div className="pin-pad">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map((k) => (
                    <button key={k} onClick={() => press(k)} disabled={busy}>{k}</button>
                  ))}
                </div>
              </div>
              <div className="clock-actions" style={{ flexDirection: "column", minWidth: 180 }}>
                {picked.status === "OUT" && (
                  <button className="btn-primary" disabled={busy || pin.length < 4} onClick={() => act("IN")}>Clock in</button>
                )}
                {picked.status === "IN" && (
                  <>
                    <button className="btn-primary" disabled={busy || pin.length < 4} onClick={() => act("OUT")}>Clock out</button>
                    <button className="btn-ghost" disabled={busy || pin.length < 4} onClick={() => act("BREAK_START")}>Start break</button>
                  </>
                )}
                {picked.status === "ON_BREAK" && (
                  <>
                    <button className="btn-primary" disabled={busy || pin.length < 4} onClick={() => act("BREAK_END")}>End break</button>
                    <button className="btn-ghost" disabled={busy || pin.length < 4} onClick={() => act("OUT")}>Clock out</button>
                  </>
                )}
                <button className="text-btn" onClick={() => { setPicked(null); setPin(""); }}>← Back</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
