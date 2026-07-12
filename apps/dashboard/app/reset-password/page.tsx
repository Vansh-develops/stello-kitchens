"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

export default function ResetPasswordPage() {
  // useSearchParams() opts this page out of static rendering and requires a
  // Suspense boundary around the client hook.
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("This reset link is missing or invalid. Request a new one.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="wordmark">STELLO KITCHENS</span>
        <h1>Reset password</h1>
        {done ? (
          <>
            <p className="form-success">Your password has been reset.</p>
            <p className="login-hint">
              <a href="/login">Sign in</a>
            </p>
          </>
        ) : (
          <>
            {!token && <p className="form-error">This reset link is missing or invalid. Request a new one.</p>}
            <label>
              New password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="btn-primary" type="submit" disabled={busy || !token}>
              {busy ? "Resetting…" : "Reset password"}
            </button>
            <p className="login-hint">
              <a href="/forgot-password">Request a new link</a>
            </p>
          </>
        )}
      </form>
    </div>
  );
}
