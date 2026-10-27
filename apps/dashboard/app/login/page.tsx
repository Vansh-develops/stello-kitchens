"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/SessionProvider";
import { LanguageSwitcher, useT } from "@/lib/i18n";

export default function LoginPage() {
  const { user, loading, login } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("admin@demo.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { t } = useT();

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.failed"));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="wordmark">STELLO KITCHENS</span>
        <h1>{t("login.title")}</h1>
        <label>{t("login.email")}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>{t("login.password")}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn-primary" type="submit" disabled={busy}>{busy ? t("login.submitting") : t("login.title")}</button>
        <a className="text-btn login-forgot" href="/forgot-password">{t("login.forgot")}</a>
        <p className="login-hint">{t("login.demo", { email: "admin@demo.com", password: "password123" })}</p>
        <LanguageSwitcher />
      </form>
    </div>
  );
}
