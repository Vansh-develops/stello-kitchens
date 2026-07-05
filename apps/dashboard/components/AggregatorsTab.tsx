"use client";

import { useCallback, useEffect, useState } from "react";
import type { AggregatorOrderDto, ReconciliationRowDto } from "@petpooja/shared";
import { api } from "@/lib/api";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });

const STATUS_TONE: Record<string, string> = {
  RECEIVED: "muted",
  ACCEPTED: "info",
  PREPARING: "info",
  READY: "info",
  PICKED_UP: "info",
  DELIVERED: "good",
  REJECTED: "bad",
  CANCELLED: "bad",
};

export function AggregatorsTab({ outletId }: { outletId: string }) {
  const [orders, setOrders] = useState<AggregatorOrderDto[]>([]);
  const [recon, setRecon] = useState<ReconciliationRowDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([api.aggregatorOrders(outletId), api.aggregatorReconciliation(outletId)]);
      setOrders(o);
      setRecon(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load aggregator orders");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 6000); // online orders arrive live
    return () => clearInterval(t);
  }, [reload]);

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Online orders</h1>
        <button className="btn-ghost sm" onClick={() => void reload()}>Refresh</button>
      </div>
      <p className="hint wide">
        Orders relayed by the connector service from Zomato / Swiggy / ONDC. They flow straight to the kitchen and
        deduct inventory like counter orders. This view refreshes every few seconds.
      </p>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      {recon.length > 0 && (
        <div className="recon-row">
          {recon.map((r) => (
            <div key={r.platform} className="recon-card">
              <span className={`plat-badge ${r.platform.toLowerCase()}`}>{r.platform}</span>
              <div className="recon-nums">
                <span className="recon-gross">{money(r.gross)}</span>
                <span className="recon-meta">
                  {r.orders} orders · {r.delivered} delivered{r.rejected ? ` · ${r.rejected} lost` : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Platform</th>
            <th>Order</th>
            <th>Items</th>
            <th className="num">Value</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="mono faint">{time(o.createdAt)}</td>
              <td><span className={`plat-badge ${o.platform.toLowerCase()}`}>{o.platform}</span></td>
              <td className="mono">{o.externalOrderId}</td>
              <td>
                {o.itemSummary}
                {o.unmatchedItems.length > 0 && (
                  <span className="unmatched" title={o.unmatchedItems.join(", ")}>
                    {o.unmatchedItems.length} unmapped
                  </span>
                )}
              </td>
              <td className="num mono">{money(o.orderValue)}</td>
              <td><span className={`status-pill ${STATUS_TONE[o.status] ?? "muted"}`}>{o.status.replace("_", " ")}</span></td>
            </tr>
          ))}
          {orders.length === 0 && <tr><td colSpan={6} className="empty">No online orders yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
