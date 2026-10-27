"use client";

import { useCallback, useEffect, useState } from "react";
import type { StaffSalesRowDto } from "@stello/shared";
import { addDays } from "@stello/shared";
import { hrApi, inr, todayIst } from "@/lib/hr-api";

export function StaffSalesView({ outletId }: { outletId: string }) {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<StaffSalesRowDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const to = todayIst();
  const from = addDays(to, -(days - 1));

  const reload = useCallback(async () => {
    try {
      setRows(await hrApi.staffSales(outletId, from, to));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [outletId, from, to]);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <div className="hr-subnav">
        <div className="range-tabs">
          {[1, 7, 30, 90].map((d) => (
            <button key={d} className={`range-tab ${days === d ? "active" : ""}`} onClick={() => setDays(d)}>
              {d === 1 ? "Today" : `${d}d`}
            </button>
          ))}
        </div>
        <span className="hint" style={{ margin: 0 }}>
          Orders taken = settled orders the person punched (sales net of discount, before tax). Bills settled = bills they closed at the counter.
        </span>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>Staff</th>
            <th className="num">Orders taken</th>
            <th className="num">Sales</th>
            <th className="num">Avg ticket</th>
            <th className="num">Items</th>
            <th className="num">Bills settled</th>
            <th className="num">Amount settled</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId}>
              <td className="strong">{r.name}{!r.staffId && <span className="faint"> · no staff profile</span>}</td>
              <td className="num mono">{r.ordersTaken}</td>
              <td className="num mono">{inr(r.salesTaken)}</td>
              <td className="num mono">{inr(r.avgTicket)}</td>
              <td className="num mono">{r.itemsSold}</td>
              <td className="num mono">{r.billsSettled}</td>
              <td className="num mono">{inr(r.amountSettled)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="empty">No settled orders in range.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
