"use client";

import { useEffect, useRef, useState } from "react";
import { fohApi } from "@/lib/foh-api";
import { cfdSessionKey, currentCfdState, subscribeCfd } from "@/lib/cfd-mirror";
import "./foh.css";

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * POS-side customer display link: pair by the 6-digit code the /cfd screen
 * shows, then mirror the POS cart / UPI QR to it (debounced pushes).
 */
export function CfdLink({ outletId }: { outletId: string }) {
  const key = cfdSessionKey(outletId);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef("");

  useEffect(() => setSessionId(read(key)), [key]);

  useEffect(() => {
    if (!sessionId) return;
    const push = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const state = currentCfdState();
        const body = JSON.stringify(state);
        if (body === lastSent.current) return;
        try {
          await fohApi.cfdPush(outletId, sessionId, state);
          lastSent.current = body;
          setLastError(false);
        } catch (e) {
          setLastError(true);
          // The display was unpaired elsewhere — forget it.
          if (e instanceof Error && /not paired/i.test(e.message)) {
            localStorage.removeItem(key);
            setSessionId(null);
          }
        }
      }, 250);
    };
    push();
    const unsub = subscribeCfd(push);
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [sessionId, outletId, key]);

  const pair = async () => {
    setError(null);
    try {
      const { id } = await fohApi.cfdPair(outletId, code.trim());
      localStorage.setItem(key, id);
      lastSent.current = "";
      setSessionId(id);
      setOpen(false);
      setCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pairing failed");
    }
  };

  const unpair = async () => {
    if (sessionId) await fohApi.cfdUnpair(outletId, sessionId).catch(() => undefined);
    localStorage.removeItem(key);
    setSessionId(null);
    setOpen(false);
  };

  return (
    <>
      <button className={`foh-btn cfd-chip ${sessionId ? "on" : ""}`} onClick={() => setOpen(true)} title="Customer-facing display">
        🖥 {sessionId ? (lastError ? "Display offline" : "Display paired") : "Pair display"}
      </button>
      {open && (
        <div className="modal-scrim" onClick={() => setOpen(false)}>
          <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Customer display</h2>
              <button className="modal-x" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              {sessionId ? (
                <>
                  <p>This counter is mirroring its bill to a customer display.</p>
                  <button className="foh-btn danger" onClick={unpair}>Unpair display</button>
                </>
              ) : (
                <>
                  <p className="foh-muted">
                    Open <strong>/cfd</strong> on the screen facing the customer, then type the 6-digit code it shows.
                  </p>
                  <input
                    autoFocus
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="000000"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => e.key === "Enter" && code.length === 6 && pair()}
                    style={{ fontSize: 28, letterSpacing: "0.3em", textAlign: "center" }}
                  />
                  {error && <p className="form-error">{error}</p>}
                  <button className="btn-primary" disabled={code.length !== 6} onClick={pair}>Pair</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
