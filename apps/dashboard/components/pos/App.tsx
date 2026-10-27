"use client";

import { useState } from "react";
import type { AuthUser, OutletDto } from "@stello/shared";
import { Billing, type BillingIntent } from "./Billing";
import { LiveFloor } from "@/components/foh/LiveFloor";
import { ReservationsBoard } from "@/components/foh/ReservationsBoard";
import { ServerCallAlerts } from "@/components/foh/ServerCallAlerts";
import { CfdLink } from "@/components/foh/CfdLink";
import "./pos.css";

type Mode = "billing" | "floor" | "reservations";

export function App({ user, outlet }: { user: AuthUser; outlet: OutletDto }) {
  const [mode, setMode] = useState<Mode>("billing");
  const [intent, setIntent] = useState<BillingIntent | null>(null);
  const can = (p: string) => user.permissions.includes("*") || user.permissions.includes(p);

  // Floor / reservations hand a table to the (always-mounted) billing screen.
  const toBilling = (next: Omit<BillingIntent, "nonce">) => {
    setIntent({ ...next, nonce: Date.now() });
    setMode("billing");
  };

  return (
    <div className="pos-root pos-with-modes">
      <nav className="pos-modes">
        {(["billing", "floor", ...(can("reservations.manage") ? ["reservations"] : [])] as Mode[]).map((m) => (
          <button key={m} className={`foh-chip ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>
            {m === "billing" ? "Billing" : m === "floor" ? "Floor" : "Reservations"}
          </button>
        ))}
        <span className="grow" />
        <CfdLink outletId={outlet.id} />
      </nav>
      <div className={`pos-mode-body ${mode === "billing" ? "" : "hidden"}`}>
        <Billing user={user} outlet={outlet} intent={intent} />
      </div>
      {mode === "floor" && (
        <div className="pos-mode-body foh-pane">
          <LiveFloor
            outletId={outlet.id}
            onOpenOrder={(orderId) => toBilling({ orderId })}
            onStartTable={(t) => toBilling({ tableId: t.id, customerName: t.reservation?.guestName })}
          />
        </div>
      )}
      {mode === "reservations" && (
        <div className="pos-mode-body">
          <ReservationsBoard
            outletId={outlet.id}
            onSeated={(g) => toBilling({ tableId: g.tableId, customerName: g.guestName, customerPhone: g.phone ?? undefined })}
          />
        </div>
      )}
      <ServerCallAlerts outletId={outlet.id} userId={user.id} />
    </div>
  );
}
