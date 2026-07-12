"use client";

import type { AuthUser, OutletDto } from "@stello/shared";
import { Billing } from "./Billing";
import "./pos.css";

export function App({ user, outlet }: { user: AuthUser; outlet: OutletDto }) {
  return (
    <div className="pos-root">
      <Billing user={user} outlet={outlet} />
    </div>
  );
}
