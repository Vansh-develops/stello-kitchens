"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/components/SessionProvider";

export default function SignupVerifyPage() {
  // useSearchParams() opts this page out of static rendering and requires a
  // Suspense boundary around the client hook.
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <SignupVerifyForm />
    </Suspense>
  );
}

function SignupVerifyForm() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const { refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setError("This verification link is missing or invalid.");
      setBusy(false);
      return;
    }
    (async () => {
      try {
        await api.verifySignup(token);
        // The API set the httpOnly session cookie; just refetch the session.
        await refresh();
        router.replace("/onboarding");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not verify this link");
        setBusy(false);
      }
    })();
  }, [token, refresh, router]);

  return (
    <div className="login">
      <div className="login-card">
        <span className="wordmark">STELLO KITCHENS</span>
        <h1>Verifying your account</h1>
        {error ? (
          <>
            <p className="form-error">{error}</p>
            <p className="login-hint">
              <a href="/signup">Back to sign up</a>
            </p>
          </>
        ) : (
          <p className="login-hint">{busy ? "Hang tight, confirming your email…" : "Redirecting…"}</p>
        )}
      </div>
    </div>
  );
}
