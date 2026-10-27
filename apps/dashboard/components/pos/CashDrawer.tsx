"use client";

import { useEffect, useState } from "react";
import type { CashSessionDto, CashSessionReportDto } from "@stello/shared";
import { posApi as api } from "@/lib/pos-api";
import { useT } from "@/lib/i18n";

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
  const { t, money: rupee } = useT();

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
      setError(err instanceof Error ? err.message : t("common.actionFailed"));
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
          <h2>{t("drawer.title")}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </header>

        <div className="modal-body">
          {!loaded && <p className="drawer-hint">{t("common.loading")}</p>}

          {loaded && report && (
            <div className="drawer-report">
              <p className="drawer-hint">{t("drawer.closedSummary")}</p>
              <div className="drawer-lines">
                <div><span>{t("drawer.openingFloat")}</span><span>{rupee(report.session.openingFloat)}</span></div>
                <div><span>{t("drawer.cashSales")}</span><span>{rupee(report.session.cashSales)}</span></div>
                <div><span>{t("drawer.payoutsExpenses")}</span><span>−{rupee(report.session.payOuts + report.session.expenses)}</span></div>
                <div className="dl-strong"><span>{t("drawer.expected")}</span><span>{rupee(report.session.expectedCash)}</span></div>
                <div><span>{t("drawer.counted")}</span><span>{rupee(report.session.countedCash ?? 0)}</span></div>
                <div className={`dl-strong ${Math.abs(report.session.variance ?? 0) > 0.01 ? "dl-off" : "dl-ok"}`}>
                  <span>{t("drawer.variance")}</span><span>{rupee(report.session.variance ?? 0)}</span>
                </div>
              </div>
            </div>
          )}

          {loaded && !report && !session && (
            <div className="drawer-open-form">
              <p className="drawer-hint">{t("drawer.noneOpen")}</p>
              <label className="drawer-field">
                {t("drawer.openingFloatInput")}
                <input type="number" value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} />
              </label>
              <button className="btn-primary grow" onClick={open} disabled={busy}>{t("drawer.open")}</button>
            </div>
          )}

          {loaded && !report && session && (
            <>
              <div className="drawer-lines">
                <div><span>{t("drawer.openingFloat")}</span><span>{rupee(session.openingFloat)}</span></div>
                <div><span>{t("drawer.cashSales")}</span><span>{rupee(session.cashSales)}</span></div>
                {session.payIns > 0 && <div><span>{t("drawer.payIns")}</span><span>{rupee(session.payIns)}</span></div>}
                {session.payOuts > 0 && <div><span>{t("drawer.payOuts")}</span><span>−{rupee(session.payOuts)}</span></div>}
                {session.expenses > 0 && <div><span>{t("drawer.expenses")}</span><span>−{rupee(session.expenses)}</span></div>}
                <div className="dl-strong"><span>{t("drawer.expected")}</span><span>{rupee(session.expectedCash)}</span></div>
              </div>

              <div className="drawer-section">
                <span className="drawer-label">{t("drawer.recordExpense")}</span>
                <div className="drawer-expense">
                  <input type="number" placeholder={t("drawer.amount")} value={expense.amount} onChange={(e) => setExpense((p) => ({ ...p, amount: e.target.value }))} />
                  <input placeholder={t("drawer.category")} value={expense.category} onChange={(e) => setExpense((p) => ({ ...p, category: e.target.value }))} />
                  <button className="btn-ghost" onClick={addExpense} disabled={busy || !expense.amount}>{t("common.add")}</button>
                </div>
              </div>

              <div className="drawer-section">
                <span className="drawer-label">{t("drawer.close")}</span>
                <div className="drawer-close">
                  <input type="number" placeholder={t("drawer.countedPlaceholder")} value={countedCash} onChange={(e) => setCountedCash(e.target.value)} />
                  <button className="btn-primary" onClick={close} disabled={busy || countedCash === ""}>{t("drawer.countClose")}</button>
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
