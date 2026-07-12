"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export default function SignupPage() {
  const [restaurantName, setRestaurantName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [closed, setClosed] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await api.signup({ restaurantName, ownerName, email, password });
      setSent(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // The backend 404s when public signup is flag-disabled; no other
      // route on this handler returns 404, so treat it as "not open yet".
      if (message.includes("404") || message === "Not Found") {
        setClosed(true);
      } else {
        setError(message || "Something went wrong");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="wordmark">STELLO KITCHENS</span>
        <h1>Create your account</h1>
        {closed ? (
          <p className="form-error">Sign-ups aren&rsquo;t open yet.</p>
        ) : sent ? (
          <p className="form-success">Check your email — we sent a verification link to {email}.</p>
        ) : (
          <>
            <label>
              Restaurant name
              <input type="text" value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)} required minLength={2} />
            </label>
            <label>
              Your name
              <input type="text" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
            </label>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create account"}
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
