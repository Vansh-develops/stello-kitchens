"use client";

import { useCallback, useEffect, useState } from "react";
import type { AuthUser, OutletDto } from "@petpooja/shared";
import { api, hasToken, setToken } from "@/lib/api";
import { Console } from "@/components/Console";

export default function Page() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [outlets, setOutlets] = useState<OutletDto[] | null>(null);
  const [outlet, setOutlet] = useState<OutletDto | null>(null);
  const [loading, setLoading] = useState(true);

  const bootstrap = useCallback(async () => {
    try {
      const me = await api.me();
      const list = await api.outlets();
      setUser(me);
      setOutlets(list);
      if (list.length === 1) setOutlet(list[0]);
    } catch {
      setToken(null);
      setUser(null);
      setOutlets(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasToken()) void bootstrap();
    else setLoading(false);
  }, [bootstrap]);

  const logout = () => {
    setToken(null);
    setUser(null);
    setOutlets(null);
    setOutlet(null);
  };

  if (loading) return <div className="boot">Loading console…</div>;

  if (!user || !outlets) {
    return (
      <Login
        onLoggedIn={async () => {
          setLoading(true);
          await bootstrap();
        }}
      />
    );
  }

  if (!outlet) {
    return (
      <div className="pick-outlet">
        <span className="wordmark">SPICE ROUTE · CONSOLE</span>
        <h1>Select outlet</h1>
        <div className="outlet-list">
          {outlets.map((o) => (
            <button key={o.id} className="outlet-card" onClick={() => setOutlet(o)}>
              <span className="outlet-brand">{o.brandName}</span>
              <span className="outlet-name">{o.name}</span>
              <span className="outlet-addr">{o.address}</span>
            </button>
          ))}
          {outlets.length === 0 && <p>No outlets assigned.</p>}
        </div>
        <button className="text-btn" onClick={logout}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <Console
      user={user}
      outlet={outlet}
      onSwitchOutlet={outlets.length > 1 ? () => setOutlet(null) : undefined}
      onLogout={logout}
    />
  );
}

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState("admin@demo.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email, password);
      setToken(res.accessToken);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="wordmark">SPICE ROUTE · CONSOLE</span>
        <h1>Sign in to manage the menu</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="login-hint">Demo: admin@demo.com / password123 (Owner)</p>
      </form>
    </div>
  );
}
