"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { io, type Socket } from "socket.io-client";
import type { CfdSessionDto } from "@stello/shared";
import { fohApi } from "@/lib/foh-api";
import { ThemeProvider } from "@/components/ThemeProvider";
import { socketOrigin } from "./useOutletSocket";
import "./cfd.css";

const TOKEN_KEY = "stello.cfd.display";
const rupee = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const store = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: pairing lasts for this page load only */
    }
  },
};

/**
 * Customer-facing display (/cfd). Unauthenticated: it holds a secret session
 * token, shows a pairing code until a POS pairs it, then mirrors the running
 * cart, totals and the UPI QR at settlement; idle shows the outlet branding.
 */
export function CustomerDisplay() {
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<CfdSessionDto | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const starting = useRef(false);

  const start = useCallback(async () => {
    if (starting.current) return;
    starting.current = true;
    try {
      const s = await fohApi.cfdStart();
      store.set(s.token);
      setToken(s.token);
    } catch {
      setOffline(true);
    } finally {
      starting.current = false;
    }
  }, []);

  useEffect(() => {
    const saved = store.get();
    if (saved) setToken(saved);
    else void start();
  }, [start]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setSession(await fohApi.cfdSession(token));
      setOffline(false);
    } catch (e) {
      if (e instanceof Error && /expired|not found|404/i.test(e.message)) {
        store.set(null);
        setToken(null);
        setSession(null);
        void start();
      } else {
        setOffline(true);
      }
    }
  }, [token, start]);

  // Socket push on the /cfd namespace, with polling as the fallback.
  useEffect(() => {
    if (!token) return;
    void refresh();
    const poll = setInterval(refresh, 4000);
    const base = socketOrigin();
    const socket: Socket = io(base ? `${base}/cfd` : "/cfd", { path: "/socket.io", transports: ["websocket", "polling"], auth: { token } });
    socket.on("cfd:state", (dto: CfdSessionDto) => setSession(dto));
    socket.on("cfd:unpaired", () => {
      store.set(null);
      setToken(null);
      setSession(null);
      void start();
    });
    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, [token, refresh, start]);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const upi = session?.state?.upi ?? null;
  useEffect(() => {
    if (!upi) {
      setQr(null);
      return;
    }
    QRCode.toDataURL(upi.upiString, { margin: 1, width: 420 }).then(setQr).catch(() => setQr(null));
  }, [upi]);

  const state = session?.state;
  const brand = session?.brandName ?? "Stello Kitchens";

  return (
    <ThemeProvider themeId={session?.themeId ?? undefined}>
      <div className="cfd">
        {!session?.paired ? (
          <div className="cfd-center">
            <span className="cfd-brand">{brand}</span>
            <h1>Customer display</h1>
            <p>On the POS, tap <strong>Pair display</strong> and enter this code</p>
            <div className="cfd-code" aria-label="Pairing code">
              {(session?.pairingCode ?? "······").split("").map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            {offline && <p className="cfd-offline">Can’t reach the server — retrying…</p>}
          </div>
        ) : state?.mode === "PAYMENT" && upi ? (
          <div className="cfd-pay">
            <div className="cfd-pay-qr">{qr ? <img src={qr} alt="UPI payment QR code" /> : <div className="cfd-qr-skel" />}</div>
            <div className="cfd-pay-info">
              <span className="cfd-brand">{brand}</span>
              <h1>Scan to pay</h1>
              <div className="cfd-amount">{rupee(upi.amount)}</div>
              <p>Use any UPI app · paying {upi.payeeVpa}</p>
              <Totals s={state} />
            </div>
          </div>
        ) : state?.mode === "CART" && state.lines.length > 0 ? (
          <div className="cfd-cart">
            <header>
              <span className="cfd-brand">{brand}</span>
              {state.label && <span className="cfd-label">{state.label}</span>}
            </header>
            <ul className="cfd-lines">
              {state.lines.map((l, i) => (
                <li key={i} className={l.pending ? "pending" : ""}>
                  <span className="q">{l.quantity}×</span>
                  <span className="n">
                    {l.name}
                    {l.detail && <small>{l.detail}</small>}
                  </span>
                  <span className="a">{rupee(l.amount)}</span>
                </li>
              ))}
            </ul>
            <Totals s={state} />
          </div>
        ) : (
          <div className="cfd-center idle">
            <span className="cfd-brand big">{brand}</span>
            <h1>Welcome{session?.outletName ? ` to ${session.outletName.replace(/^.* - /, "")}` : ""}</h1>
            <p>{clock.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p>
            {offline && <p className="cfd-offline">Reconnecting…</p>}
          </div>
        )}
      </div>
    </ThemeProvider>
  );
}

function Totals({ s }: { s: NonNullable<CfdSessionDto["state"]> }) {
  return (
    <div className="cfd-totals">
      <div><span>Subtotal</span><span>{rupee(s.subtotal)}</span></div>
      {s.discount > 0 && <div><span>Discount</span><span>−{rupee(s.discount)}</span></div>}
      {s.tax > 0 && <div><span>GST</span><span>{rupee(s.tax)}</span></div>}
      <div className="grand"><span>Total</span><span>{rupee(s.total)}</span></div>
    </div>
  );
}
