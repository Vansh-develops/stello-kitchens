"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { hasPermission, type AuthUser, type MfaSetupDto, type MfaStatusDto } from "@stello/shared";
import { platformApi } from "@/lib/platform-api";
import { useSession } from "@/components/SessionProvider";
import { RecoveryCodes } from "./RecoveryCodes";
import "./platform.css";

/** Own 2FA (enrol, recovery codes, disable), tenant 2FA policy, and sign-out-everywhere. */
export function SecurityTab({ user }: { user: AuthUser }) {
  const { logout } = useSession();
  const [status, setStatus] = useState<MfaStatusDto | null>(null);
  const [policy, setPolicy] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<(MfaSetupDto & { qr: string }) | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [mode, setMode] = useState<"idle" | "disable" | "regen">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canPolicy = hasPermission(user.permissions, "settings.manage");

  const load = useCallback(async () => {
    try {
      setStatus(await platformApi.mfaStatus());
      if (canPolicy) setPolicy((await platformApi.securitySettings()).requireOwnerMfa);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load security settings");
    }
  }, [canPolicy]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const begin = () =>
    act(async () => {
      const s = await platformApi.mfaSetup();
      setSetup({ ...s, qr: await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 200 }) });
      setCodes(null);
      setCode("");
    });

  const enable = () =>
    act(async () => {
      const res = await platformApi.mfaEnable(code.replace(/\s/g, ""));
      setCodes(res.recoveryCodes);
      setSetup(null);
      await load();
    });

  const disable = () =>
    act(async () => {
      await platformApi.mfaDisable(password, confirmCode.replace(/\s/g, "") || undefined);
      setMode("idle");
      setPassword("");
      setConfirmCode("");
      await load();
    });

  const regen = () =>
    act(async () => {
      const res = await platformApi.mfaRecoveryCodes(password, confirmCode.replace(/\s/g, "") || undefined);
      setCodes(res.recoveryCodes);
      setMode("idle");
      setPassword("");
      setConfirmCode("");
      await load();
    });

  const togglePolicy = (next: boolean) =>
    act(async () => {
      setPolicy((await platformApi.setSecuritySettings({ requireOwnerMfa: next })).requireOwnerMfa);
      await load();
    });

  const signOutEverywhere = () =>
    act(async () => {
      await platformApi.logoutAll();
      logout();
    });

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Security</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="pf-grid">
        <div className="report-card pf-stack">
          <span className="card-title">Two-factor authentication · {user.email}</span>
          {!status && <p className="hint">Loading…</p>}
          {status && !status.enabled && !setup && (
            <>
              <p className="pf-muted">
                Protect your account with a 6-digit code from an authenticator app on your phone, asked for at every sign-in.
                {status.requiredByPolicy && " Your restaurant requires this for owners."}
              </p>
              <div className="pf-row"><button className="btn-primary sm" disabled={busy} onClick={() => void begin()}>Set up 2FA</button></div>
            </>
          )}
          {setup && (
            <>
              <p className="pf-muted">Scan with Google Authenticator, Microsoft Authenticator, Authy or 1Password, then enter the code it shows.</p>
              <div className="mfa-qr-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} />
                <div className="mfa-manual">
                  <span>Can&apos;t scan? Enter this key:</span>
                  <code>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                </div>
              </div>
              <div className="pf-row">
                <label className="pf-label">
                  6-digit code
                  <input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" />
                </label>
                <button className="btn-primary sm" disabled={busy || code.replace(/\s/g, "").length !== 6} onClick={() => void enable()}>Turn on</button>
                <button className="text-btn" onClick={() => setSetup(null)}>Cancel</button>
              </div>
            </>
          )}
          {codes && <RecoveryCodes codes={codes} />}
          {status?.enabled && (
            <>
              <div className="pf-row between">
                <span><span className="status-pill good">On</span> <span className="pf-faint">since {status.enabledAt ? new Date(status.enabledAt).toLocaleDateString("en-IN") : "—"}</span></span>
                <span className="pf-faint">{status.recoveryCodesRemaining} recovery codes left</span>
              </div>
              {mode === "idle" && (
                <div className="pf-row">
                  <button className="btn-ghost sm" onClick={() => setMode("regen")}>New recovery codes</button>
                  {!status.requiredByPolicy && <button className="btn-ghost sm danger" onClick={() => setMode("disable")}>Turn off</button>}
                </div>
              )}
              {mode !== "idle" && (
                <div className="pf-stack">
                  <p className="pf-muted">{mode === "disable" ? "Confirm with your password and a current code to turn 2FA off." : "Confirm to replace your recovery codes; the old ones stop working."}</p>
                  <div className="pf-row">
                    <label className="pf-label">Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
                    <label className="pf-label">Code<input inputMode="numeric" maxLength={7} value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} placeholder="123 456" /></label>
                  </div>
                  <div className="pf-row">
                    <button className={mode === "disable" ? "btn-primary sm danger" : "btn-primary sm"} disabled={busy || !password} onClick={() => void (mode === "disable" ? disable() : regen())}>
                      {mode === "disable" ? "Turn off 2FA" : "Generate new codes"}
                    </button>
                    <button className="text-btn" onClick={() => setMode("idle")}>Cancel</button>
                  </div>
                </div>
              )}
              {status.requiredByPolicy && <p className="pf-faint">Required by your restaurant&apos;s policy, so it can&apos;t be turned off.</p>}
            </>
          )}
        </div>

        <div className="pf-stack">
          {canPolicy && policy !== null && (
            <div className="report-card pf-stack">
              <span className="card-title">Restaurant policy</span>
              <label className="pf-switch">
                <input type="checkbox" checked={policy} disabled={busy} onChange={(e) => void togglePolicy(e.target.checked)} />
                Require two-factor authentication for owners
              </label>
              <p className="pf-faint">
                Owners (full-access roles) without 2FA will be asked to set it up the next time they sign in. Turn it on
                for your own account first.
              </p>
            </div>
          )}
          <div className="report-card pf-stack">
            <span className="card-title">Sessions</span>
            <p className="pf-muted">Signed in on a shared or lost device? Sign out of every browser and device where your account is signed in, including this one.</p>
            <div className="pf-row"><button className="btn-ghost sm" disabled={busy} onClick={() => void signOutEverywhere()}>Sign out everywhere</button></div>
          </div>
        </div>
      </div>
    </div>
  );
}
