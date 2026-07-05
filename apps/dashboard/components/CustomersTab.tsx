"use client";

import { useCallback, useEffect, useState } from "react";
import type { CustomerDetailDto, CustomerDto, CustomerSummaryDto } from "@petpooja/shared";
import { api } from "@/lib/api";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");
const SEGMENTS = ["NEW", "REGULAR", "VIP", "LAPSED"] as const;
const segTone: Record<string, string> = { NEW: "muted", REGULAR: "info", VIP: "good", LAPSED: "bad" };

export function CustomersTab({ outletId }: { outletId: string }) {
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [summary, setSummary] = useState<CustomerSummaryDto | null>(null);
  const [detail, setDetail] = useState<CustomerDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.customers(outletId), api.customerSummary(outletId)]);
      setCustomers(c);
      setSummary(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load customers");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Customers</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      {summary && (
        <div className="inv-stats">
          <div className="stat">
            <span className="stat-label">Customers</span>
            <span className="stat-value">{summary.total}</span>
          </div>
          {SEGMENTS.map((s) => (
            <div key={s} className="stat">
              <span className="stat-label">{s}</span>
              <span className={`stat-value seg-${segTone[s]}`}>{summary.segments[s]}</span>
            </div>
          ))}
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Phone</th>
            <th>Segment</th>
            <th className="num">Orders</th>
            <th className="num">Spent</th>
            <th className="num">Points</th>
            <th>Last visit</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td className="strong">{c.name ?? "—"}</td>
              <td className="mono faint">{c.phone}</td>
              <td><span className={`status-pill ${segTone[c.segment]}`}>{c.segment}</span></td>
              <td className="num mono">{c.totalOrders}</td>
              <td className="num mono">{money(c.totalSpent)}</td>
              <td className="num mono">{c.loyaltyPoints}</td>
              <td className="faint">{date(c.lastVisitAt)}</td>
              <td className="row-actions">
                <button className="text-btn" onClick={() => void api.customerDetail(outletId, c.id).then(setDetail)}>
                  View
                </button>
              </td>
            </tr>
          ))}
          {customers.length === 0 && <tr><td colSpan={8} className="empty">No customers yet — they’re created when an order is settled with a phone number.</td></tr>}
        </tbody>
      </table>

      {detail && (
        <CustomerDetailModal
          outletId={outletId}
          detail={detail}
          onClose={() => setDetail(null)}
          onChanged={async () => {
            const fresh = await api.customerDetail(outletId, detail.customer.id);
            setDetail(fresh);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function CustomerDetailModal({
  outletId,
  detail,
  onClose,
  onChanged,
}: {
  outletId: string;
  detail: CustomerDetailDto;
  onClose: () => void;
  onChanged: () => void;
}) {
  const c = detail.customer;
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adjust = async () => {
    const p = Number(points);
    if (!p) return setError("Enter a non-zero point amount (use a minus for deductions).");
    setBusy(true);
    setError(null);
    try {
      await api.adjustLoyalty(outletId, c.id, { points: p, note: note.trim() || undefined });
      setPoints("");
      setNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not adjust");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{c.name ?? c.phone}</h2>
            <span className="settle-sub">
              {c.phone} · <span className={`status-pill ${segTone[c.segment]}`}>{c.segment}</span> · {c.totalOrders} orders · {money(c.totalSpent)}
            </span>
          </div>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>
        <div className="modal-body">
          <div className="wallet-head">
            <div>
              <span className="opt-label">Loyalty balance</span>
              <strong className="wallet-points">{c.loyaltyPoints} pts</strong>
            </div>
            <div className="wallet-adjust">
              <input type="number" placeholder="± points" value={points} onChange={(e) => setPoints(e.target.value)} />
              <input placeholder="Note (e.g. goodwill)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn-primary sm" onClick={adjust} disabled={busy}>Apply</button>
            </div>
          </div>
          {error && <p className="form-error">{error}</p>}

          <section className="editor-section">
            <h3>Loyalty ledger</h3>
            {detail.transactions.length === 0 && <p className="hint">No transactions.</p>}
            <ul className="ledger">
              {detail.transactions.map((t) => (
                <li key={t.id}>
                  <span className={`ledger-type ${t.points >= 0 ? "pos" : "neg"}`}>{t.type}</span>
                  <span className="ledger-note">{t.note ?? ""}</span>
                  <span className={`mono ${t.points >= 0 ? "pos" : "neg"}`}>{t.points >= 0 ? "+" : ""}{t.points}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="editor-section">
            <h3>Order history</h3>
            {detail.orders.length === 0 && <p className="hint">No settled orders.</p>}
            <ul className="ledger">
              {detail.orders.map((o) => (
                <li key={o.id}>
                  <span className="mono">{o.billNumber}</span>
                  <span className="ledger-note">{o.orderType.replace("_", " ").toLowerCase()} · {date(o.createdAt)}</span>
                  <span className="mono">{money(o.total)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
