"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { App as Kds } from "@/components/kds/App";
import { useAuthGuard, OutletPicker } from "@/components/OutletPicker";

export default function KdsPage() {
  // useSearchParams() opts this page out of static rendering and requires a
  // Suspense boundary around the client hook.
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <KdsRoute />
    </Suspense>
  );
}

function KdsRoute() {
  const wall = useSearchParams().get("display") === "wall";
  const { user, loading, outlets, outlet, setOutlet, logout } = useAuthGuard();
  const board = user && outlet ? <Kds user={user} outlet={outlet} /> : null;

  // Wall mode: full-screen board, no shell chrome (for a dedicated kitchen
  // screen). It still needs auth + an outlet — useAuthGuard() above redirects
  // to /login once signed out; here we block on outlet selection (using the
  // same picker Shell uses) before dropping into the full-screen board.
  if (wall) {
    if (loading || !user) return <div className="boot">Loading…</div>;
    if (!outlet) return <OutletPicker outlets={outlets} onPick={setOutlet} onSignOut={logout} />;
    return <div className="kds-wall">{board}</div>;
  }

  return <Shell surface="kds">{board}</Shell>;
}
