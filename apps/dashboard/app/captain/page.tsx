"use client";

import { Shell } from "@/components/Shell";
import { Captain } from "@/components/captain/Captain";
import { useSession } from "@/components/SessionProvider";

// Waiter / captain ordering surface (phone-first).
export default function CaptainPage() {
  const { user, outlet } = useSession();
  return <Shell surface="captain">{user && outlet && <Captain user={user} outlet={outlet} />}</Shell>;
}
