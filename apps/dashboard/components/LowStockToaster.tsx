"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { LowStockEvent } from "@stello/shared";
import { integrationsApi } from "@/lib/integrations-api";

/**
 * In-app low-stock alerts: listens for `inventory:low-stock` on the outlet room
 * and shows a dismissible banner per crossing (acknowledging it server-side).
 */
export function LowStockToaster({ outletId }: { outletId: string }) {
  const [alerts, setAlerts] = useState<LowStockEvent[]>([]);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("stello.token") : null;
    const origin =
      process.env.NEXT_PUBLIC_SOCKET_ORIGIN ??
      (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? `${window.location.protocol}//${window.location.hostname}:3001`
        : undefined);
    const socket: Socket = io(origin, { path: "/socket.io", transports: ["websocket", "polling"], auth: { token } });
    socket.on("connect", () => socket.emit("join", { outletId }));
    socket.on("inventory:low-stock", (e: LowStockEvent) => {
      if (e.outletId === outletId) setAlerts((prev) => [e, ...prev.filter((a) => a.id !== e.id)].slice(0, 4));
    });
    return () => {
      socket.close();
    };
  }, [outletId]);

  const dismiss = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    void integrationsApi.ackLowStock(outletId, id).catch(() => undefined);
  };

  return (
    <>
      {alerts.map((a) => (
        <div key={a.id} className="lowstock-banner" role="status" onClick={() => dismiss(a.id)}>
          Low stock: <strong>{a.materialName}</strong> is at {a.stockQty} {a.unit} (reorder level {a.reorderLevel} {a.unit})
          {a.notified > 0 ? ` · ${a.notified} staff notified` : ""} — dismiss
        </div>
      ))}
    </>
  );
}
