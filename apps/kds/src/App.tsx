import { useCallback, useEffect, useState } from "react";
import type { OutletDto } from "@stello/shared";
import { api, hasToken, setToken } from "./api";
import { Board } from "./Board";

export function App() {
  const [outlets, setOutlets] = useState<OutletDto[] | null>(null);
  const [outlet, setOutlet] = useState<OutletDto | null>(null);
  const [loading, setLoading] = useState(hasToken());

  const bootstrap = useCallback(async () => {
    try {
      await api.me();
      const list = await api.outlets();
      setOutlets(list);
      if (list.length === 1) setOutlet(list[0]);
    } catch {
      setToken(null);
      setOutlets(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasToken()) void bootstrap();
  }, [bootstrap]);

  if (loading) return <div className="boot">Connecting to kitchen…</div>;

  if (!outlets) {
    return (
      <LoginScreen
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
        <span className="wordmark">STELLO KITCHENS · KDS</span>
        <h1>Choose the kitchen this screen serves</h1>
        <div className="outlet-list">
          {outlets.map((o) => (
            <button key={o.id} className="outlet-card" onClick={() => setOutlet(o)}>
              <span className="outlet-name">{o.name}</span>
              <span className="outlet-addr">{o.address}</span>
            </button>
          ))}
          {outlets.length === 0 && <p>No outlets assigned to this account.</p>}
        </div>
      </div>
    );
  }

  return (
    <Board
      outlet={outlet}
      onExit={() => {
        setToken(null);
        setOutlets(null);
        setOutlet(null);
      }}
    />
  );
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState("kitchen@demo.com");
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
        <span className="wordmark">STELLO KITCHENS · KDS</span>
        <h1>Kitchen display sign-in</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Open kitchen"}
        </button>
        <p className="login-hint">Demo: kitchen@demo.com / password123</p>
      </form>
    </div>
  );
}
