"use client";

import { useCallback, useEffect, useState } from "react";
import type { EdgeConflictDto, EdgeDeviceDto, EdgeSeriesRowDto, EdgeStaffPinRowDto } from "@stello/shared";
import { edgeApi } from "@/lib/edge-api";

const KIND_LABEL: Record<string, string> = {
  COUPON_LIMIT_EXCEEDED: "Coupon over usage limit",
  COUPON_INVALID: "Coupon not valid at sale time",
  COUPON_DISCOUNT_MISMATCH: "Coupon amount differs",
  PRICE_DRIFT: "Billed at an old price",
  BILL_NUMBER_DUPLICATE: "Invoice number reused",
  BILL_SERIES_MISMATCH: "Invoice from a foreign series",
  STAFF_UNKNOWN: "Unknown staff",
  TABLE_UNKNOWN: "Table no longer exists",
  CLOCK_SKEW: "Terminal clock was wrong",
  REJECTED: "Rejected — sale NOT recorded",
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";

/**
 * Offline POS administration: edge terminals and their invoice series, staff
 * PINs for offline login, and the sync conflicts that offline sales raised.
 */
export function EdgeTab({ outletId }: { outletId: string }) {
  const [devices, setDevices] = useState<EdgeDeviceDto[]>([]);
  const [staff, setStaff] = useState<EdgeStaffPinRowDto[]>([]);
  const [conflicts, setConflicts] = useState<EdgeConflictDto[]>([]);
  const [series, setSeries] = useState<EdgeSeriesRowDto[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [resolving, setResolving] = useState<{ id: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [d, s, c, se] = await Promise.all([
        edgeApi.devices(outletId),
        edgeApi.staff(outletId),
        edgeApi.conflicts(outletId, showResolved ? undefined : "OPEN"),
        edgeApi.series(outletId),
      ]);
      setDevices(d);
      setStaff(s);
      setConflicts(c);
      setSeries(se);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load offline POS data");
    }
  }, [outletId, showResolved]);

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

  const savePin = (userId: string, name: string) =>
    run(async () => {
      if (!/^\d{4,6}$/.test(pin)) throw new Error("PIN must be 4 to 6 digits");
      await edgeApi.setPin(outletId, userId, pin);
      setPin("");
      setPinFor(null);
    }, `PIN set for ${name} — terminals pick it up on their next sync`);

  const openCount = conflicts.filter((c) => c.status === "OPEN").length;

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Offline POS</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {message && <div className="banner-ok" onClick={() => setMessage(null)}>{message}</div>}
      <p className="hint wide">
        Edge terminals keep billing when the internet is down. Each has its own GST invoice series (for example
        <code> E01/2627/000042</code>), signs staff in with an offline PIN, and uploads its sales when it reconnects. Sales the
        cloud could not take exactly as billed are listed under <b>Needs review</b> — the sale is kept; you decide the follow-up.
      </p>

      <div className="section-head">
        <h3>Needs review {openCount > 0 && <span className="badge">{openCount}</span>}</h3>
        <label className="chip-select">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
      </div>
      {conflicts.length === 0 ? (
        <p className="empty">Nothing to review.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Invoice</th>
              <th>Issue</th>
              <th>Details</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {conflicts.map((c) => (
              <tr key={c.id}>
                <td>{when(c.createdAt)}</td>
                <td className="mono">{c.billNumber ?? c.clientId.slice(0, 8)}</td>
                <td>
                  <span className={`status-pill ${c.status === "RESOLVED" ? "muted" : c.kind === "REJECTED" ? "bad" : "info"}`}>{KIND_LABEL[c.kind] ?? c.kind}</span>
                </td>
                <td>
                  {c.message}
                  {c.resolutionNote && <div className="hint">Resolved: {c.resolutionNote}</div>}
                </td>
                <td className="row-actions">
                  {c.status === "OPEN" &&
                    (resolving?.id === c.id ? (
                      <span className="field-row">
                        <input
                          autoFocus
                          placeholder="What was done?"
                          value={resolving.note}
                          maxLength={300}
                          onChange={(e) => setResolving({ id: c.id, note: e.target.value })}
                        />
                        <button
                          className="btn-primary sm"
                          disabled={!resolving.note.trim()}
                          onClick={() => run(() => edgeApi.resolve(outletId, c.id, resolving.note.trim()).then(() => setResolving(null)), "Marked resolved")}
                        >
                          Save
                        </button>
                      </span>
                    ) : (
                      <button className="text-btn" onClick={() => setResolving({ id: c.id, note: "" })}>
                        Resolve
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-head">
        <h3>Staff PINs</h3>
      </div>
      <p className="hint wide">Staff sign in to an edge terminal with a 4–6 digit PIN, even offline. Five wrong tries lock that person out on the terminal for 5 minutes (doubling on repeats).</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Staff</th>
            <th>Role</th>
            <th>Offline PIN</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.userId}>
              <td>{s.name}</td>
              <td>{s.roleName}</td>
              <td>{s.hasPin ? <span className="status-pill good">set {when(s.pinUpdatedAt)}</span> : <span className="status-pill muted">none</span>}</td>
              <td className="row-actions">
                {pinFor === s.userId ? (
                  <span className="field-row">
                    <input
                      autoFocus
                      type="password"
                      inputMode="numeric"
                      autoComplete="new-password"
                      placeholder="4–6 digits"
                      maxLength={6}
                      value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    />
                    <button className="btn-primary sm" onClick={() => savePin(s.userId, s.name)}>
                      Save
                    </button>
                    <button className="text-btn" onClick={() => { setPinFor(null); setPin(""); }}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <button className="text-btn" onClick={() => { setPinFor(s.userId); setPin(""); }}>
                      {s.hasPin ? "Change PIN" : "Set PIN"}
                    </button>
                    {s.hasPin && (
                      <button className="text-btn danger" onClick={() => run(() => edgeApi.clearPin(outletId, s.userId), `PIN removed for ${s.name}`)}>
                        Remove
                      </button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
          {staff.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">No staff are assigned to this outlet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="section-head">
        <h3>Edge terminals</h3>
      </div>
      <p className="hint wide">
        Activate a terminal from the edge app itself (owner sign-in, once). Re-activating gives it a fresh invoice series; revoking stops it syncing until it is re-activated.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Terminal</th>
            <th>Series</th>
            <th>Activated</th>
            <th>Last upload</th>
            <th>Last catalog pull</th>
            <th>Clock</th>
            <th>Review</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td>{d.terminalName}</td>
              <td className="mono">{d.seriesCode}</td>
              <td>{when(d.activatedAt)}</td>
              <td>{when(d.lastPushAt)}</td>
              <td>{when(d.lastPullAt)}</td>
              <td>
                {d.clockSkewMs == null ? "—" : Math.abs(d.clockSkewMs) > 120000 ? (
                  <span className="status-pill bad">{Math.round(d.clockSkewMs / 60000)} min off</span>
                ) : (
                  <span className="status-pill good">ok</span>
                )}
              </td>
              <td>{d.openConflicts || "—"}</td>
              <td className="row-actions">
                {d.revokedAt ? (
                  <span className="status-pill muted">revoked</span>
                ) : (
                  <button className="text-btn danger" onClick={() => run(() => edgeApi.revokeDevice(outletId, d.id), `${d.terminalName} (${d.seriesCode}) revoked`)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {devices.length === 0 && (
            <tr>
              <td colSpan={8} className="empty">No edge terminal has been activated for this outlet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="section-head">
        <h3>Offline invoice series</h3>
      </div>
      {series.length === 0 ? (
        <p className="empty">No offline invoices have synced yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Series</th>
              <th>Financial year</th>
              <th>Invoices synced</th>
              <th>Last number</th>
              <th>Missing numbers</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={`${s.edgeDeviceId}-${s.fiscalYear}`}>
                <td className="mono">{s.seriesCode}</td>
                <td>
                  20{s.fiscalYear.slice(0, 2)}–{s.fiscalYear.slice(2)}
                </td>
                <td>{s.count}</td>
                <td className="mono">{s.lastSeq}</td>
                <td>
                  {s.missing.length === 0 ? (
                    <span className="status-pill good">none</span>
                  ) : (
                    <span className="status-pill info" title="Usually bills still waiting on a terminal that has not reconnected">
                      {s.missing.slice(0, 10).join(", ")}
                      {s.missing.length > 10 ? "…" : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
