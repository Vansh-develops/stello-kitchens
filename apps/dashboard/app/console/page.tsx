"use client";

import { Shell } from "@/components/Shell";
import { Console } from "@/components/Console";
import { useSession } from "@/components/SessionProvider";

export default function ConsolePage() {
  const { user, outlet } = useSession();
  return (
    <Shell surface="console">
      {user && outlet && <Console user={user} outlet={outlet} />}
    </Shell>
  );
}
