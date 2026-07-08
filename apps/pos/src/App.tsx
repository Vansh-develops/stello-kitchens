import { useCallback, useEffect, useState } from "react";
import type { AuthUser, OutletDto } from "@stello/shared";
import { api, hasToken, setToken } from "./api";
import { Billing } from "./Billing";
import { ThemeProvider } from "./ThemeProvider";

type Session = { user: AuthUser; outlets: OutletDto[] };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [outlet, setOutlet] = useState<OutletDto | null>(null);
  const [loading, setLoading] = useState(hasToken());

  const bootstrap = useCallback(async () => {
    try {
      const user = await api.me();
      const outlets = await api.outlets();
      setSession({ user, outlets });
      if (outlets.length === 1) setOutlet(outlets[0]);
    } catch {
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasToken()) void bootstrap();
  }, [bootstrap]);

  const logout = () => {
    setToken(null);
    setSession(null);
    setOutlet(null);
  };

  if (loading) {
    return (
      <ThemeProvider themeId={outlet?.themeId}>
        <div className="boot">Loading…</div>
      </ThemeProvider>
    );
  }

  if (!session) {
    return (
      <ThemeProvider themeId={outlet?.themeId}>
        <LoginScreen
          onLoggedIn={async () => {
            setLoading(true);
            await bootstrap();
          }}
        />
      </ThemeProvider>
    );
  }

  if (!outlet) {
    return (
      <ThemeProvider>
        <div className="pick-outlet">
          <header>
            <span className="wordmark">STELLO KITCHENS POS</span>
            <span className="pick-user">{session.user.name}</span>
          </header>
          <h1>Select outlet</h1>
          <div className="outlet-list">
            {session.outlets.map((o) => (
              <button key={o.id} className="outlet-card" onClick={() => setOutlet(o)}>
                <span className="outlet-brand">{o.brandName}</span>
                <span className="outlet-name">{o.name}</span>
                <span className="outlet-addr">{o.address}</span>
              </button>
            ))}
            {session.outlets.length === 0 && <p>No outlets assigned to your account.</p>}
          </div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider themeId={outlet?.themeId}>
      <Billing
        user={session.user}
        outlet={outlet}
        onSwitchOutlet={session.outlets.length > 1 ? () => setOutlet(null) : undefined}
        onLogout={logout}
      />
    </ThemeProvider>
  );
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
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
        <span className="wordmark">STELLO KITCHENS POS</span>
        <h1>Sign in to the counter</h1>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="login-hint">Demo: admin@demo.com / password123</p>
      </form>
    </div>
  );
}
