"use client";

import type { AuthUser, OutletDto } from "@stello/shared";
import { useSession } from "@/components/SessionProvider";
import { Board } from "./Board";
import "./kds.css";

export function App({ user, outlet }: { user: AuthUser; outlet: OutletDto }) {
  const { logout } = useSession();
  return (
    <div className="kds-root">
      <Board outlet={outlet} onExit={logout} />
    </div>
  );
}
