"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { OutletDto } from "@stello/shared";
import { useSession } from "@/components/SessionProvider";
import { ThemeProvider } from "@/components/ThemeProvider";

/**
 * Shared auth/loading guard: once the session has resolved, redirects to
 * /login if there's no signed-in user. Returns the session as-is — callers
 * are responsible for rendering a loading state while `loading` is true or
 * `user` hasn't resolved yet (the redirect hasn't landed on the next render
 * pass otherwise). Used by both `Shell` (surface routes) and the KDS wall
 * route, which has no Shell to guard it.
 */
export function useAuthGuard() {
  const session = useSession();
  const router = useRouter();
  const { user, loading } = session;

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  return session;
}

/**
 * Outlet-picker UI: outlet selection is shared across surfaces (pick once,
 * every surface uses it). Extracted out of `Shell` so the chrome-free KDS
 * wall route can render the same picker before dropping into the board.
 */
export function OutletPicker({
  outlets,
  onPick,
  onSignOut,
}: {
  outlets: OutletDto[];
  onPick: (o: OutletDto) => void;
  onSignOut: () => void;
}) {
  return (
    <ThemeProvider>
      <div className="pick-outlet">
        <span className="wordmark">STELLO KITCHENS</span>
        <h1>Select outlet</h1>
        <div className="outlet-list">
          {outlets.map((o) => (
            <button key={o.id} className="outlet-card" onClick={() => onPick(o)}>
              <span className="outlet-brand">{o.brandName}</span>
              <span className="outlet-name">{o.name}</span>
              <span className="outlet-addr">{o.address}</span>
            </button>
          ))}
          {outlets.length === 0 && <p>No outlets assigned.</p>}
        </div>
        <button className="text-btn" onClick={onSignOut}>Sign out</button>
      </div>
    </ThemeProvider>
  );
}
