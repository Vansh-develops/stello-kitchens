"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, setToken } from "@/lib/api";
import { useSession } from "@/components/SessionProvider";

export default function InviteAcceptPage() {
  // useSearchParams() opts this page out of static rendering and requires a
  // Suspense boundary around the client hook.
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <InviteAcceptForm />
    </Suspense>
  );
}

function InviteAcceptForm() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const { refresh } = useSession();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("This invite link is missing or invalid.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.acceptInvite(token, name, password);
      // Same mechanism SessionProvider.login() uses internally: stash the
      // token where the api client reads it, then let the session refetch.
      setToken(res.accessToken);
      await refresh();
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "This invite link is invalid or has expired.");
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="wordmark">STELLO KITCHENS</span>
        <h1>Join your team</h1>
        {!token ? (
          <p className="form-error">This invite link is missing or invalid.</p>
        ) : (
          <>
            <label>
              Your name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? "Joining…" : "Join"}
            </button>
          </>
        )}
        <p className="login-hint">
          <a href="/login">Already have an account? Sign in</a>
        </p>
      </form>
    </div>
  );
}
