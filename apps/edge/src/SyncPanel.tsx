import { useCallback, useEffect, useState } from "react";
import { edge, type ConflictRow, type EdgeStatus, type KdsScreen, type OutboxRow, type StaffSession } from "./api";

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleString("en-IN");
};

const CONFLICT_LABEL: Record<string, string> = {
  COUPON_LIMIT_EXCEEDED: "Coupon over its limit",
  COUPON_INVALID: "Coupon not valid",
  COUPON_DISCOUNT_MISMATCH: "Coupon amount differs",
  PRICE_DRIFT: "Price changed",
  BILL_NUMBER_DUPLICATE: "Invoice number reused",
  BILL_SERIES_MISMATCH: "Invoice series mismatch",
  STAFF_UNKNOWN: "Unknown staff",
  TABLE_UNKNOWN: "Table missing",
  CLOCK_SKEW: "Clock was wrong",
  REJECTED: "Rejected — not in cloud",
};

/** Sync status, conflicts to review, outbox, and LAN kitchen-screen pairing. */
export function SyncPanel({ staff, onClose, onChanged }: { staff: StaffSession; onClose: () => void; onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [outbox, setOutbox] = useState<OutboxRow[]>([]);
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [screens, setScreens] = useState<KdsScreen[]>([]);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; lan: { urls: string[] } | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, sc] = await Promise.all([edge.syncState(), edge.screens()]);
      setStatus(s.status);
      setOutbox(s.outbox);
      setConflicts(s.conflicts);
      setScreens(sc);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not load sync state");
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
      await load();
      await onChanged();
    }
  };

  const online = !!status && status.online && !status.forcedOffline;
  const skewMin = status ? Math.round(status.clockSkewMs / 60000) : 0;
  const open = conflicts.filter((c) => !c.acknowledgedAt);

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Sync and kitchen">
        <div className="modal-head">
          <h2>Sync &amp; kitchen</h2>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {msg && <p className="flash">{msg}</p>}
        {status && (
          <section className="sp-section">
            <div className="sp-stats">
              <div>
                <span className="sp-k">Cloud</span>
                <span className={`net ${online ? "online" : "offline"}`}>
                  <span className="net-dot" /> {online ? "Online" : status.forcedOffline ? "Offline (simulated)" : "Offline"}
                </span>
              </div>
              <div>
                <span className="sp-k">Last synced</span>
                <span>{ago(status.lastSyncAt)}</span>
              </div>
              <div>
                <span className="sp-k">Catalog pulled</span>
                <span>{ago(status.lastPullAt)}</span>
              </div>
              <div>
                <span className="sp-k">Waiting to upload</span>
                <strong className="mono">{status.pending}</strong>
              </div>
              <div>
                <span className="sp-k">Invoice series</span>
                <span className="mono">{status.seriesCode}</span>
              </div>
              <div>
                <span className="sp-k">To review</span>
                <strong className="mono">{open.length}</strong>
              </div>
            </div>
            {Math.abs(skewMin) >= 2 && (
              <p className="form-error">
                This terminal&apos;s clock is {Math.abs(skewMin)} min {skewMin > 0 ? "behind" : "ahead of"} the cloud. Fix the system clock — sales are time-corrected on sync, but receipts print the local time.
              </p>
            )}
            {status.authError && <p className="form-error">Cloud refused this device ({status.authError}). An owner must re-activate the terminal.</p>}
            {status.lastError && !status.authError && <p className="faint">Last attempt: {status.lastError}</p>}
            <div className="inline">
              <button className="btn-primary" disabled={busy || status.forcedOffline} onClick={() => void act(() => edge.sync(), "Synced")}>
                Sync now
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => void act(() => edge.setOffline(!status.forcedOffline))}>
                {status.forcedOffline ? "Reconnect" : "Simulate offline"}
              </button>
            </div>
          </section>
        )}

        <section className="sp-section">
          <h3>Needs review {open.length > 0 && <span className="badge-warn">{open.length}</span>}</h3>
          {conflicts.length === 0 && <p className="faint">Nothing to review. Sales the cloud could not take exactly as billed appear here and in Console › Offline POS.</p>}
          {conflicts.slice(0, 30).map((c) => (
            <div key={c.id} className={`sp-conflict ${c.acknowledgedAt ? "done" : ""}`}>
              <div>
                <strong>{CONFLICT_LABEL[c.kind] ?? c.kind}</strong> <span className="mono faint">{c.billNumber ?? c.clientId.slice(0, 8)}</span>
                <p>{c.message}</p>
              </div>
              {!c.acknowledgedAt ? (
                <button className="btn-ghost" onClick={() => void act(() => edge.ackConflict(c.id))}>
                  Seen
                </button>
              ) : (
                <span className="faint">seen</span>
              )}
            </div>
          ))}
        </section>

        <section className="sp-section">
          <h3>Kitchen screens on this network</h3>
          <p className="faint">Kitchen tablets on the same Wi-Fi open this terminal&apos;s address in a browser and pair with a one-time code. Tickets keep flowing with the internet down.</p>
          <button className="btn-secondary" onClick={() => void act(async () => setPairing(await edge.pairingCode()))}>
            Pair a screen
          </button>
          {pairing && (
            <div className="pair-box">
              <span className="pair-code mono">{pairing.code}</span>
              <span className="faint">valid until {new Date(pairing.expiresAt).toLocaleTimeString("en-IN")}</span>
              {pairing.lan?.urls.length ? (
                <span>
                  Open {pairing.lan.urls.map((u) => (
                    <code key={u}>{u} </code>
                  ))}
                </span>
              ) : (
                <span className="form-error">The LAN kitchen service is not listening (EDGE_LAN_PORT=0?).</span>
              )}
            </div>
          )}
          {screens.map((s) => (
            <div key={s.id} className="sp-row">
              <span>{s.name}</span>
              <span className="faint">{s.revokedAt ? "revoked" : `seen ${ago(s.lastSeenAt)}`}</span>
              {!s.revokedAt && (
                <button className="btn-ghost danger" onClick={() => void act(() => edge.revokeScreen(s.id), `${s.name} unpaired`)}>
                  Unpair
                </button>
              )}
            </div>
          ))}
        </section>

        <section className="sp-section">
          <h3>Outbox</h3>
          {outbox.length === 0 && <p className="faint">Empty.</p>}
          <table className="sp-table">
            <tbody>
              {outbox.slice(0, 25).map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.kind === "ORDER" ? "Bill" : "Kitchen"}</td>
                  <td className="mono faint">{o.clientId.slice(0, 8)}</td>
                  <td>
                    <span className={`sync-pill ${o.status === "done" ? "synced" : o.status === "pending" ? "pending" : "bad"}`}>{o.status}</span>
                  </td>
                  <td className="faint">{o.status === "pending" && o.attempts > 0 ? `retry ${ago(o.nextAttemptAt).replace(" ago", "")} · ${o.lastError ?? ""}` : ago(o.doneAt ?? o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <p className="faint sp-foot">Signed in as {staff.name} ({staff.roleName}).</p>
      </aside>
    </div>
  );
}
