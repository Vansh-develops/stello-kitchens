"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import type { MfaChallengeResponse, MfaSetupDto } from "@stello/shared";
import { useSession } from "@/components/SessionProvider";
import { platformApi } from "@/lib/platform-api";
import { RecoveryCodes } from "@/components/platform/RecoveryCodes";

type Step =
  | { kind: "password" }
  | { kind: "verify"; mfaToken: string; useRecovery: boolean }
  | { kind: "enroll"; mfaToken: string; setup: MfaSetupDto | null; qr: string | null }
  | { kind: "codes"; codes: string[] };

export default function LoginPage() {
  const { user, loading, login, refresh } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("admin@demo.com");
  const [password, setPassword] = useState("password123");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user && step.kind !== "codes") router.replace("/");
  }, [loading, user, router, step.kind]);

  const fail = (err: unknown, fallback: string) => {
    setError(err instanceof Error ? err.message : fallback);
    setBusy(false);
  };

  const startEnroll = async (challenge: MfaChallengeResponse) => {
    setStep({ kind: "enroll", mfaToken: challenge.mfaToken, setup: null, qr: null });
    const setup = await platformApi.mfaEnrollStart(challenge.mfaToken);
    const qr = await QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 200 });
    setStep({ kind: "enroll", mfaToken: challenge.mfaToken, setup, qr });
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const challenge = await login(email, password);
      if (!challenge) {
        router.replace("/");
        return;
      }
      setCode("");
      if (challenge.mfa === "verify") setStep({ kind: "verify", mfaToken: challenge.mfaToken, useRecovery: false });
      else await startEnroll(challenge);
      setBusy(false);
    } catch (err) {
      fail(err, "Login failed");
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== "verify") return;
    setBusy(true);
    setError(null);
    try {
      await platformApi.mfaChallenge(step.mfaToken, step.useRecovery ? { recoveryCode: code } : { code: code.replace(/\s/g, "") });
      await refresh();
      router.replace("/");
    } catch (err) {
      fail(err, "Verification failed");
    }
  };

  const submitEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== "enroll") return;
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi.mfaEnrollConfirm(step.mfaToken, code.replace(/\s/g, ""));
      setStep({ kind: "codes", codes: res.recoveryCodes });
      setBusy(false);
      await refresh();
    } catch (err) {
      fail(err, "That code didn't match");
    }
  };

  const restart = () => {
    setStep({ kind: "password" });
    setCode("");
    setError(null);
  };

  return (
    <div className="login">
      {step.kind === "password" && (
        <form className="login-card" onSubmit={submitPassword}>
          <span className="wordmark">STELLO KITCHENS</span>
          <h1>Sign in</h1>
          <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="btn-primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          <a className="text-btn login-forgot" href="/forgot-password">Forgot password?</a>
          <p className="login-hint">Demo: admin@demo.com / password123</p>
        </form>
      )}

      {step.kind === "verify" && (
        <form className="login-card" onSubmit={submitCode}>
          <span className="wordmark">STELLO KITCHENS</span>
          <h1>Two-factor check</h1>
          <p className="hint">
            {step.useRecovery
              ? "Enter one of the recovery codes you saved when you turned on two-factor authentication. Each code works once."
              : "Open your authenticator app and enter the 6-digit code for Stello Kitchens."}
          </p>
          {step.useRecovery ? (
            <label>Recovery code<input autoFocus autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="abcd-efgh-ijkl" required /></label>
          ) : (
            <label>Authentication code
              <input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" required />
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <button className="btn-primary" type="submit" disabled={busy}>{busy ? "Checking…" : "Verify"}</button>
          <button type="button" className="text-btn login-forgot" onClick={() => { setStep({ ...step, useRecovery: !step.useRecovery }); setCode(""); setError(null); }}>
            {step.useRecovery ? "Use an authenticator code instead" : "Lost your phone? Use a recovery code"}
          </button>
          <button type="button" className="text-btn login-forgot" onClick={restart}>Start over</button>
        </form>
      )}

      {step.kind === "enroll" && (
        <form className="login-card" onSubmit={submitEnroll}>
          <span className="wordmark">STELLO KITCHENS</span>
          <h1>Set up two-factor authentication</h1>
          <p className="hint">Your restaurant requires owners to use an authenticator app. Scan this code with Google Authenticator, Microsoft Authenticator, Authy or 1Password, then enter the 6-digit code it shows.</p>
          {step.setup && step.qr ? (
            <div className="mfa-qr-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={step.qr} alt="QR code for your authenticator app" width={200} height={200} />
              <div className="mfa-manual">
                <span>Can&apos;t scan? Enter this key:</span>
                <code>{step.setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              </div>
            </div>
          ) : (
            <p className="hint">Preparing your key…</p>
          )}
          <label>Authentication code
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" required />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="btn-primary" type="submit" disabled={busy || !step.setup}>{busy ? "Checking…" : "Turn on and sign in"}</button>
          <button type="button" className="text-btn login-forgot" onClick={restart}>Start over</button>
        </form>
      )}

      {step.kind === "codes" && (
        <div className="login-card">
          <span className="wordmark">STELLO KITCHENS</span>
          <h1>Save your recovery codes</h1>
          <RecoveryCodes codes={step.codes} />
          <button className="btn-primary" onClick={() => router.replace("/")}>I&apos;ve saved them, continue</button>
        </div>
      )}
    </div>
  );
}
