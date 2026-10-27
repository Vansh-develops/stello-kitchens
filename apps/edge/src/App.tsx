import { useCallback, useEffect, useState } from "react";
import { edge, onStaffSessionLost, setStaffSession, type EdgeStatus, type StaffRow, type StaffSession } from "./api";
import { ThemeProvider } from "./ThemeProvider";
import { Pos } from "./Pos";

export function App() {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [staff, setStaff] = useState<StaffSession | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await edge.status());
      setBootError(null);
    } catch (err) {
      setBootError(err instanceof Error ? err.message : "Sidecar unreachable");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const t = setInterval(() => void refreshStatus(), 4000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  useEffect(() => {
    onStaffSessionLost(() => {
      setStaffSession(null);
      setStaff(null);
    });
  }, []);

  const logout = async () => {
    try {
      await edge.logout();
    } finally {
      setStaffSession(null);
      setStaff(null);
    }
  };

  if (!status) {
    return (
      <ThemeProvider>
        <div className="boot">{bootError ?? "Starting local master service…"}</div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider themeId={status.themeId ?? undefined}>
      {!status.activated ? (
        <Setup status={status} onDone={refreshStatus} />
      ) : !staff ? (
        <PinLogin status={status} onLogin={(s) => setStaff(s)} />
      ) : (
        <Pos status={status} staff={staff} onLogout={logout} onStatus={refreshStatus} />
      )}
    </ThemeProvider>
  );
}

/** First run: an authorised user binds and activates this terminal (needs the internet once). */
function Setup({ status, onDone }: { status: EdgeStatus; onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [outletId, setOutletId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    if (!email.trim() || !password) return setError("Enter an authorised staff email and password.");
    setBusy(true);
    setError(null);
    try {
      await edge.bootstrap(email.trim(), password, outletId.trim() || undefined);
      setPassword("");
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect">
      <form
        className="connect-card"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <span className="wordmark">STELLO KITCHENS · EDGE</span>
        <h1>Activate this terminal</h1>
        <p className="connect-hint">
          Device {status.deviceId}. Sign in once with an owner or manager account (needs the internet). The terminal gets its own GST invoice
          series and caches the menu, tables, staff PINs and coupons — after that it bills with the internet down.
        </p>
        {status.authError && <p className="form-error">The cloud refused this device: {status.authError}. Re-activate to continue syncing.</p>}
        {error && <p className="form-error">{error}</p>}
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Outlet id <span className="faint">(only if the account has several outlets)</span>
          <input value={outletId} onChange={(e) => setOutletId(e.target.value)} placeholder="optional" />
        </label>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Activating…" : "Activate & download catalog"}
        </button>
      </form>
    </div>
  );
}

/** Offline-capable staff login against cached PIN hashes. */
function PinLogin({ status, onLogin }: { status: EdgeStatus; onLogin: (s: StaffSession) => void }) {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [picked, setPicked] = useState<StaffRow | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    edge.staff().then(setStaff).catch((e: Error) => setError(e.message));
  }, [status.lastPullAt]);

  const submit = async (value: string) => {
    if (!picked || value.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const res = await edge.pinLogin(picked.id, value);
      setStaffSession(res.token);
      onLogin(res.staff);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => {
    if (!busy) setPin((p) => (p + d).slice(0, 6));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!picked) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") void submit(pin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const online = status.online && !status.forcedOffline;
  return (
    <div className="connect">
      <div className="connect-card pin-card">
        <div className="pin-head">
          <span className="wordmark">STELLO KITCHENS</span>
          <span className={`net ${online ? "online" : "offline"}`}>
            <span className="net-dot" /> {online ? "ONLINE" : "OFFLINE"}
          </span>
        </div>
        <p className="connect-hint">
          {status.outletName} · invoice series {status.seriesCode}
        </p>
        {!picked ? (
          <>
            <h1>Who is billing?</h1>
            {staff.length === 0 && <p className="connect-hint">No staff cached yet. Connect once so the terminal can download the staff list.</p>}
            <div className="staff-grid">
              {staff.map((s) => (
                <button
                  key={s.id}
                  className="staff-btn"
                  disabled={!s.hasPin}
                  onClick={() => setPicked(s)}
                  title={s.hasPin ? s.name : "No PIN set — set one in Console › Offline POS"}
                >
                  <span className="staff-initial">{s.name.slice(0, 1)}</span>
                  <span>{s.name}</span>
                  <span className="faint">{s.hasPin ? s.roleName : "no PIN"}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <h1>
              {picked.name}{" "}
              <button
                className="link-btn"
                onClick={() => {
                  setPicked(null);
                  setPin("");
                  setError(null);
                }}
              >
                change
              </button>
            </h1>
            <div className="pin-dots" aria-label="PIN">
              {Array.from({ length: 6 }).map((_, i) => (
                <span key={i} className={i < pin.length ? "on" : ""} />
              ))}
            </div>
            {error && <p className="form-error">{error}</p>}
            <div className="pinpad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} onClick={() => press(d)}>
                  {d}
                </button>
              ))}
              <button className="ghost" onClick={() => setPin("")}>
                Clear
              </button>
              <button onClick={() => press("0")}>0</button>
              <button className="go" disabled={busy || pin.length < 4} onClick={() => void submit(pin)}>
                {busy ? "…" : "Enter"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
