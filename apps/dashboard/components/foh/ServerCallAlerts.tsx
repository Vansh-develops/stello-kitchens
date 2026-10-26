"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerCallDto, ServerCallType } from "@stello/shared";
import { fohApi } from "@/lib/foh-api";
import { useOutletSocket } from "./useOutletSocket";
import "./foh.css";

export const CALL_LABEL: Record<ServerCallType, string> = {
  WAITER: "needs a server",
  WATER: "asked for water",
  BILL: "asked for the bill",
};
export const CALL_ICON: Record<ServerCallType, string> = { WAITER: "🙋", WATER: "💧", BILL: "🧾" };

/** Short two-tone chime via WebAudio (no asset to ship, works offline). */
export function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    /* audio blocked until first user gesture — the toast still shows */
  }
}

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};

/**
 * Live "call a server" alerts: a toast stack with sound for every new call,
 * acknowledge ("On my way") and resolve actions. Used on POS, floor and captain.
 * `userId` floats the caller's own section to the top and marks it.
 */
export function ServerCallAlerts({ outletId, userId, onChange }: { outletId: string; userId?: string; onChange?: () => void }) {
  const [calls, setCalls] = useState<ServerCallDto[]>([]);
  const [now, setNow] = useState(Date.now());
  const [muted, setMuted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const load = useCallback(async () => {
    try {
      const list = await fohApi.calls(outletId);
      list.forEach((c) => seen.current.add(c.id));
      setCalls(list);
    } catch {
      /* transient — the next poll/socket push retries */
    }
  }, [outletId]);

  useEffect(() => {
    void load();
    const poll = setInterval(load, 15000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  useOutletSocket(outletId, {
    onCall: (call) => {
      if (call.status === "OPEN" && !seen.current.has(call.id)) {
        if (!mutedRef.current) chime();
        setCollapsed(false);
      }
      seen.current.add(call.id);
      setCalls((prev) => {
        const rest = prev.filter((c) => c.id !== call.id);
        return call.status === "RESOLVED" ? rest : [...rest, call];
      });
      onChange?.();
    },
  });

  const act = async (call: ServerCallDto, action: "ack" | "resolve") => {
    try {
      const updated = action === "ack" ? await fohApi.ackCall(outletId, call.id) : await fohApi.resolveCall(outletId, call.id);
      setCalls((prev) => (updated.status === "RESOLVED" ? prev.filter((c) => c.id !== call.id) : prev.map((c) => (c.id === call.id ? updated : c))));
    } catch {
      await load();
    }
  };

  const mine = (c: ServerCallDto) => !!userId && c.assignedUserIds.includes(userId);
  const sorted = [...calls].sort(
    (a, b) =>
      Number(mine(b)) - Number(mine(a)) ||
      Number(a.status !== "OPEN") - Number(b.status !== "OPEN") ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const open = calls.filter((c) => c.status === "OPEN").length;
  if (calls.length === 0) return null;

  return (
    <div className={`call-stack ${collapsed ? "collapsed" : ""}`} role="region" aria-label="Table calls" aria-live="polite">
      <div className="call-stack-head">
        <button className="call-stack-title" onClick={() => setCollapsed((v) => !v)}>
          <span className={`call-dot ${open ? "hot" : ""}`} />
          {open ? `${open} new call${open > 1 ? "s" : ""}` : `${calls.length} in progress`}
          <span className="call-caret">{collapsed ? "▾" : "▴"}</span>
        </button>
        <button className="call-mute" onClick={() => setMuted((m) => !m)} title={muted ? "Unmute alerts" : "Mute alerts"}>
          {muted ? "🔕" : "🔔"}
        </button>
      </div>
      {!collapsed &&
        sorted.map((c) => (
          <div key={c.id} className={`call-toast ${c.status === "OPEN" ? "open" : "acked"} ${mine(c) ? "mine" : ""}`}>
            <span className="call-icon" aria-hidden>{CALL_ICON[c.type]}</span>
            <div className="call-text">
              <strong>{c.tableName}</strong> {CALL_LABEL[c.type]}
              <small>
                {ago(c.createdAt, now)} ago
                {c.acknowledgedBy ? ` · ${c.acknowledgedBy} on the way` : ""}
                {mine(c) ? " · your section" : ""}
              </small>
            </div>
            <div className="call-actions">
              {c.status === "OPEN" && (
                <button className="call-btn" onClick={() => act(c, "ack")}>
                  On my way
                </button>
              )}
              <button className="call-btn done" onClick={() => act(c, "resolve")}>
                Done
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
