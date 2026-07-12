"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { surfaceAccess, type Surface } from "@stello/shared";
import { useAuthGuard, OutletPicker } from "@/components/OutletPicker";
import { ThemeProvider } from "@/components/ThemeProvider";

const LABEL: Record<Surface, string> = { console: "Console", pos: "POS", kds: "KDS" };

export function Shell({ surface, children }: { surface: Surface; children: React.ReactNode }) {
  const { user, loading, outlets, outlet, setOutlet, logout } = useAuthGuard();
  const router = useRouter();
  const pathname = usePathname();

  const access = user ? surfaceAccess(user.permissions) : { allowed: [], primary: null };

  useEffect(() => {
    if (loading || !user) return;
    if (!access.allowed.includes(surface)) router.replace("/");
  }, [loading, user, surface, router, access.allowed]);

  if (loading || !user) return <div className="boot">Loading…</div>;
  if (!access.allowed.includes(surface)) return <div className="boot">Redirecting…</div>;

  // Outlet selection is shared across surfaces: pick once, all surfaces use it.
  if (!outlet) {
    return <OutletPicker outlets={outlets} onPick={setOutlet} onSignOut={logout} />;
  }

  return (
    <ThemeProvider themeId={outlet.themeId}>
      <div className="shell">
        <header className="shell-bar">
          <span className="wordmark">STELLO KITCHENS</span>
          {access.allowed.length > 1 && (
            <nav className="surface-switch">
              {access.allowed.map((s) => (
                <button
                  key={s}
                  className={pathname?.startsWith(`/${s}`) ? "active" : ""}
                  onClick={() => router.push(`/${s}`)}
                >
                  {LABEL[s]}
                </button>
              ))}
            </nav>
          )}
          <div className="shell-right">
            <span className="shell-outlet">{outlet.name}{outlets.length > 1 ? "" : ""}</span>
            {outlets.length > 1 && (
              <button className="text-btn" onClick={() => setOutlet(null)}>Switch outlet</button>
            )}
            <span className="shell-user">{user.name}</span>
            <button className="text-btn" onClick={logout}>Sign out</button>
          </div>
        </header>
        <main className="shell-body">{children}</main>
      </div>
    </ThemeProvider>
  );
}
