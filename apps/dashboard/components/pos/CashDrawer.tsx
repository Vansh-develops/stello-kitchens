"use client";

import { useEffect, useState } from "react";
import type { CashSessionDto, CashSessionReportDto } from "@stello/shared";
import { posApi as api } from "@/lib/pos-api";

const rupee = (n: number) => `₹${n.toFixed(2)}`;

export function CashDrawer({
  outletId,
  onClose,
  onChanged,
}: {
  outletId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [session, setSession] = useState<CashSessionDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [report, setReport] = useState<CashSessionReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // forms
  const [openingFloat, setOpeningFloat] = useState("2000");
  const [countedCash, setCountedCash] = useState("");
  const [expense, setExpense] = useState({ amount: "", category: "General", note: "" });

  const load = async () => {
    const s = await api.cashCurrent(outletId);
    setSession(s);
    setLoaded(true);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletId]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const open = () => run(() => api.cashOpen(outletId, Number(openingFloat) || 0));
  const addExpense = () =>
    run(async () => {
      await api.cashMovement(outletId, {
        type: "EXPENSE",
        amount: Number(expense.amount) || 0,
        category: expense.category,
        note: expense.note || undefined,
      });
      setExpense({ amount: "", category: "General", note: "" });
    });
  const close = () =>
    run(async () => {
      const rep = await api.cashClose(outletId, Number(countedCash) || 0);
      setReport(rep);
    });

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal settle-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Cash drawer</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>

        <div className="modal-body">
          {!loaded && <p className="drawer-hint">Loading…</p>}

          {loaded && report && (
            <div className="drawer-report">
              <p className="drawer-hint">Drawer closed. Summary:</p>
              <div className="drawer-lines">
                <div><span>Opening float</span><span>{rupee(report.session.openingFloat)}</span></div>
                <div><span>Cash sales</span><span>{rupee(report.session.cashSales)}</span></div>
                <div><span>Pay-outs + expenses</span><span>−{rupee(report.session.payOuts + report.session.expenses)}</span></div>
                <div className="dl-strong"><span>Expected in drawer</span><span>{rupee(report.session.expectedCash)}</span></div>
                <div><span>Counted</span><span>{rupee(report.session.countedCash ?? 0)}</span></div>
                <div className={`dl-strong ${Math.abs(report.session.variance ?? 0) > 0.01 ? "dl-off" : "dl-ok"}`}>
                  <span>Variance</span><span>{rupee(report.session.variance ?? 0)}</span>
                </div>
              </div>
            </div>
          )}

          {loaded && !report && !session && (
            <div className="drawer-open-form">
              <p className="drawer-hint">No drawer is open. Start a shift with the opening float.</p>
              <label className="drawer-field">
                Opening float (₹)
                <input type="number" value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} />
              </label>
              <button className="btn-primary grow" onClick={open} disabled={busy}>Open drawer</button>
            </div>
          )}

          {loaded && !report && session && (
            <>
              <div className="drawer-lines">
                <div><span>Opening float</span><span>{rupee(session.openingFloat)}</span></div>
                <div><span>Cash sales</span><span>{rupee(session.cashSales)}</span></div>
                {session.payIns > 0 && <div><span>Pay-ins</span><span>{rupee(session.payIns)}</span></div>}
                {session.payOuts > 0 && <div><span>Pay-outs</span><span>−{rupee(session.payOuts)}</span></div>}
                {session.expenses > 0 && <div><span>Expenses</span><span>−{rupee(session.expenses)}</span></div>}
                <div className="dl-strong"><span>Expected in drawer</span><span>{rupee(session.expectedCash)}</span></div>
              </div>

              <div className="drawer-section">
                <span className="drawer-label">Record expense / pay-out</span>
                <div className="drawer-expense">
                  <input type="number" placeholder="Amount" value={expense.amount} onChange={(e) => setExpense((p) => ({ ...p, amount: e.target.value }))} />
                  <input placeholder="Category" value={expense.category} onChange={(e) => setExpense((p) => ({ ...p, category: e.target.value }))} />
                  <button className="btn-ghost" onClick={addExpense} disabled={busy || !expense.amount}>Add</button>
                </div>
              </div>

              <div className="drawer-section">
                <span className="drawer-label">Close drawer</span>
                <div className="drawer-close">
                  <input type="number" placeholder="Counted cash (₹)" value={countedCash} onChange={(e) => setCountedCash(e.target.value)} />
                  <button className="btn-primary" onClick={close} disabled={busy || countedCash === ""}>Count &amp; close</button>
                </div>
              </div>
            </>
          )}

          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
