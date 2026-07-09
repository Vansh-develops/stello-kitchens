"use client";

import { Shell } from "@/components/Shell";
import { App as Pos } from "@/components/pos/App";
import { useSession } from "@/components/SessionProvider";

export default function PosPage() {
  const { user, outlet } = useSession();
  return (
    <Shell surface="pos">
      {user && outlet && <Pos user={user} outlet={outlet} />}
    </Shell>
  );
}
