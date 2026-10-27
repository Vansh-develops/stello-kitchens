"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "./hr.css";
import type { DayBookDto, ExpenseCategoryDto, ExpenseDto, ExpenseInput, ExpensePaidFrom, PnlDto, PnlFigures } from "@stello/shared";
import { addDays } from "@stello/shared";
import { downloadText, hrApi, inr, timeIst, todayIst } from "@/lib/hr-api";

export type FinanceView = "expenses" | "pnl" | "daybook";

const PAID_FROM: Record<ExpensePaidFrom, string> = {
  CASH_DRAWER: "Cash drawer",
  BANK: "Bank transfer",
  UPI: "UPI",
  CARD: "Card",
  PAYABLE: "Credit (payable)",
};

function useRange(initialDays: number) {
  const [days, setDays] = useState(initialDays);
  const to = todayIst();
  const from = useMemo(() => addDays(to, -(days - 1)), [to, days]);
  return { days, setDays, from, to };
}

// ---------- Expenses ----------

export function ExpensesView({ outletId }: { outletId: string }) {
  const { days, setDays, from, to } = useRange(30);
  const [rows, setRows] = useState<ExpenseDto[]>([]);
  const [cats, setCats] = useState<ExpenseCategoryDto[]>([]);
  const [newCat, setNewCat] = useState("");
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blank = (): ExpenseInput => ({
    categoryId: cats.find((c) => c.isActive)?.id ?? "",
    date: todayIst(),
    taxableAmount: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    itcEligible: true,
    vendorName: "",
    vendorGstin: "",
    invoiceNumber: "",
    paidFrom: "BANK",
    reference: "",
    note: "",
    attachmentUrl: "",
  });
  const [form, setForm] = useState<ExpenseInput | null>(null);

  const reload = useCallback(async () => {
    try {
      const [e, c] = await Promise.all([hrApi.expenses(outletId, from, to), hrApi.expenseCategories()]);
      setRows(e);
      setCats(c);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load expenses");
    }
  }, [outletId, from, to]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const live = rows.filter((r) => !r.voidedAt);
  const totals = {
    spend: live.reduce((s, r) => s + r.total, 0),
    itc: live.filter((r) => r.itcEligible).reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0),
    drawer: live.filter((r) => r.paidFrom === "CASH_DRAWER").reduce((s, r) => s + r.total, 0),
  };
  const gst = form ? form.cgst + form.sgst + form.igst : 0;

  const save = async () => {
    if (!form) return;
    const clean = <T,>(v: T) => (v === "" ? null : v);
    await run(async () => {
      await hrApi.createExpense(outletId, {
        ...form,
        vendorName: clean(form.vendorName),
        vendorGstin: clean(form.vendorGstin),
        invoiceNumber: clean(form.invoiceNumber),
        reference: clean(form.reference),
        note: clean(form.note),
        attachmentUrl: clean(form.attachmentUrl),
      });
      setForm(null);
    });
  };

  return (
    <>
      <div className="hr-subnav">
        <div className="range-tabs">
          {[7, 30, 90].map((d) => (
            <button key={d} className={`range-tab ${days === d ? "active" : ""}`} onClick={() => setDays(d)}>{d}d</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn-ghost sm" onClick={() => void hrApi.tallyExpenses(outletId, from, to).then((r) => downloadText(r.filename, r.xml, "application/xml")).catch((e) => setError(e.message))}>
          Expenses to Tally (XML)
        </button>
        <button className="btn-primary sm" disabled={cats.length === 0} onClick={() => setForm(blank())}>+ Record expense</button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <div className="inv-stats">
        <div className="stat"><span className="stat-label">Spend</span><span className="stat-value">{inr(totals.spend)}</span></div>
        <div className="stat"><span className="stat-label">GST input credit</span><span className="stat-value seg-good">{inr(totals.itc)}</span></div>
        <div className="stat"><span className="stat-label">From cash drawer</span><span className="stat-value">{inr(totals.drawer)}</span></div>
      </div>

      <div className="hr-grid-2">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Vendor / note</th>
              <th>Paid from</th>
              <th className="num">Taxable</th>
              <th className="num">GST</th>
              <th className="num">Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className={e.voidedAt ? "low" : ""}>
                <td className="faint mono">{e.date.slice(5)}</td>
                <td className="strong">{e.categoryName}</td>
                <td>
                  {[e.vendorName, e.invoiceNumber && `#${e.invoiceNumber}`, e.note].filter(Boolean).join(" · ") || <span className="faint">—</span>}
                  {e.attachmentUrl && <> · <a href={e.attachmentUrl} target="_blank" rel="noreferrer">bill</a></>}
                  {e.voidedAt && <div className="faint">Void: {e.voidReason}</div>}
                </td>
                <td className="faint">{PAID_FROM[e.paidFrom]}{e.fromDrawer && e.paidFrom === "CASH_DRAWER" ? " (POS)" : ""}</td>
                <td className="num mono">{inr(e.taxableAmount)}</td>
                <td className="num mono">{e.cgst + e.sgst + e.igst ? inr(e.cgst + e.sgst + e.igst) : "—"}{e.cgst + e.sgst + e.igst > 0 && !e.itcEligible ? "*" : ""}</td>
                <td className="num mono strong">{inr(e.total)}</td>
                <td className="row-actions">
                  {!e.voidedAt && <button className="text-btn danger" onClick={() => setVoiding({ id: e.id, reason: "" })}>Void</button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="empty">No expenses in range. Cash-drawer expenses from the POS appear here too.</td></tr>}
          </tbody>
        </table>

        <aside className="side-card">
          <h3>Categories</h3>
          <ul className="vendor-list">
            {cats.map((c) => (
              <li key={c.id}>
                <span className={c.isActive ? "" : "faint"}>{c.name}</span>
                <span className="faint mono">{c.ledgerName ? `Tally: ${c.ledgerName}` : ""}</span>
                <button className="text-btn" onClick={() => void run(() => hrApi.updateExpenseCategory(c.id, { isActive: !c.isActive }))}>
                  {c.isActive ? "Hide" : "Show"}
                </button>
              </li>
            ))}
          </ul>
          <div className="add-vendor">
            <input placeholder="New category" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
            <button
              className="btn-primary sm"
              disabled={!newCat.trim()}
              onClick={() => void run(async () => { await hrApi.createExpenseCategory({ name: newCat.trim(), isActive: true }); setNewCat(""); })}
            >
              Add
            </button>
          </div>
        </aside>
      </div>

      {form && (
        <div className="modal-scrim" onClick={() => setForm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h2>Record expense</h2>
              <button className="modal-x" onClick={() => setForm(null)}>✕</button>
            </header>
            <div className="modal-body">
              <div className="hr-form">
                <label className="field">
                  Category
                  <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                    {cats.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="field">Date<input type="date" value={form.date} max={todayIst()} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
                <label className="field">
                  Paid from
                  <select value={form.paidFrom} onChange={(e) => setForm({ ...form, paidFrom: e.target.value as ExpensePaidFrom })}>
                    {(Object.keys(PAID_FROM) as ExpensePaidFrom[]).map((k) => <option key={k} value={k}>{PAID_FROM[k]}</option>)}
                  </select>
                </label>
                <label className="field">Taxable amount ₹<input type="number" min={0} value={form.taxableAmount || ""} onChange={(e) => setForm({ ...form, taxableAmount: Number(e.target.value) || 0 })} /></label>
                <label className="field">CGST ₹<input type="number" min={0} value={form.cgst || ""} onChange={(e) => setForm({ ...form, cgst: Number(e.target.value) || 0 })} /></label>
                <label className="field">SGST ₹<input type="number" min={0} value={form.sgst || ""} onChange={(e) => setForm({ ...form, sgst: Number(e.target.value) || 0 })} /></label>
                <label className="field">IGST ₹<input type="number" min={0} value={form.igst || ""} onChange={(e) => setForm({ ...form, igst: Number(e.target.value) || 0 })} /></label>
                <label className="field">Vendor<input value={form.vendorName ?? ""} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} /></label>
                <label className="field">Vendor GSTIN<input value={form.vendorGstin ?? ""} maxLength={15} onChange={(e) => setForm({ ...form, vendorGstin: e.target.value.toUpperCase() })} /></label>
                <label className="field">Bill / invoice no.<input value={form.invoiceNumber ?? ""} onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })} /></label>
                <label className="field">Payment ref.<input value={form.reference ?? ""} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
                <label className="field wide">Note<input value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
                <label className="field wide">Bill link (optional URL — Drive, Dropbox…)<input value={form.attachmentUrl ?? ""} onChange={(e) => setForm({ ...form, attachmentUrl: e.target.value })} placeholder="https://" /></label>
                {gst > 0 && (
                  <label className="hr-check wide">
                    <input type="checkbox" checked={form.itcEligible} onChange={(e) => setForm({ ...form, itcEligible: e.target.checked })} />
                    GST input credit can be claimed (excluded from P&amp;L cost)
                  </label>
                )}
              </div>
              <p className="hint">Total {inr(form.taxableAmount + gst)}{form.paidFrom === "CASH_DRAWER" ? " — taken out of the open cash drawer." : ""}</p>
            </div>
            <footer className="modal-foot">
              <button className="btn-ghost" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn-primary grow" disabled={!form.categoryId || form.taxableAmount + gst <= 0} onClick={save}>Save expense</button>
            </footer>
          </div>
        </div>
      )}

      {voiding && (
        <div className="modal-scrim" onClick={() => setVoiding(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <header className="modal-head">
              <h2>Void expense</h2>
              <button className="modal-x" onClick={() => setVoiding(null)}>✕</button>
            </header>
            <div className="modal-body">
              <p className="hint">A drawer-paid expense on a still-open drawer is paid back in as cash.</p>
              <label className="field">Reason<input value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} autoFocus /></label>
            </div>
            <footer className="modal-foot">
              <button className="btn-ghost" onClick={() => setVoiding(null)}>Cancel</button>
              <button
                className="btn-primary grow"
                disabled={voiding.reason.trim().length < 3}
                onClick={() => void run(async () => { await hrApi.voidExpense(outletId, voiding.id, voiding.reason.trim()); setVoiding(null); })}
              >
                Void
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- P&L ----------

function monthStart(d: string) {
  return `${d.slice(0, 7)}-01`;
}

export function PnlView({ outletId }: { outletId: string }) {
  const today = todayIst();
  const presets = useMemo(() => {
    const thisMonth = monthStart(today);
    const prevEnd = addDays(thisMonth, -1);
    return [
      { id: "mtd", label: "This month", from: thisMonth, to: today },
      { id: "last", label: "Last month", from: monthStart(prevEnd), to: prevEnd },
      { id: "30", label: "Last 30 days", from: addDays(today, -29), to: today },
      { id: "90", label: "Last 90 days", from: addDays(today, -89), to: today },
    ];
  }, [today]);
  const [preset, setPreset] = useState("mtd");
  const [compare, setCompare] = useState<"prev" | "yoy" | "none">("prev");
  const [pnl, setPnl] = useState<PnlDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = presets.find((p) => p.id === preset)!;

  useEffect(() => {
    let cancelled = false;
    hrApi
      .pnl(outletId, range.from, range.to, compare)
      .then((p) => !cancelled && (setPnl(p), setError(null)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load P&L"));
    return () => {
      cancelled = true;
    };
  }, [outletId, range.from, range.to, compare]);

  const c = pnl?.current;
  const p = pnl?.compare ?? null;
  const cats = useMemo(() => {
    const names = new Set([...(c?.expenses ?? []), ...(p?.expenses ?? [])].map((e) => e.category));
    return [...names];
  }, [c, p]);
  const catAmt = (f: PnlFigures | null, name: string) => f?.expenses.find((e) => e.category === name)?.amount ?? 0;

  const Row = ({ label, cur, prev, cls = "", invert = false }: { label: string; cur: number; prev?: number; cls?: string; invert?: boolean }) => {
    const delta = p && prev !== undefined ? cur - prev : null;
    const good = delta !== null && (invert ? delta < 0 : delta > 0);
    return (
      <tr className={cls}>
        <td>{label}</td>
        <td className="num mono">{inr(cur)}</td>
        {p && <td className="num mono faint">{inr(prev ?? 0)}</td>}
        {p && (
          <td className={`num mono ${delta ? (good ? "pnl-up" : "pnl-down") : "faint"}`}>
            {delta ? `${delta > 0 ? "+" : "−"}${inr(Math.abs(delta))}` : "—"}
          </td>
        )}
      </tr>
    );
  };

  return (
    <>
      <div className="hr-subnav">
        <div className="range-tabs">
          {presets.map((x) => (
            <button key={x.id} className={`range-tab ${preset === x.id ? "active" : ""}`} onClick={() => setPreset(x.id)}>{x.label}</button>
          ))}
        </div>
        <select value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)}>
          <option value="prev">vs previous period</option>
          <option value="yoy">vs same period last year</option>
          <option value="none">no comparison</option>
        </select>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {c && (
        <>
          <div className="inv-stats">
            <div className="stat"><span className="stat-label">Net sales</span><span className="stat-value">{inr(c.netSales)}</span></div>
            <div className="stat"><span className="stat-label">Gross margin</span><span className="stat-value">{c.netSales ? `${Math.round((c.grossProfit / c.netSales) * 100)}%` : "—"}</span></div>
            <div className="stat"><span className="stat-label">Net profit</span><span className={`stat-value ${c.netProfit >= 0 ? "seg-good" : ""}`}>{inr(c.netProfit)}</span></div>
            <div className="stat"><span className="stat-label">Orders</span><span className="stat-value">{c.orders}</span></div>
          </div>
          <table className="data-table pnl-table">
            <thead>
              <tr>
                <th>{range.from} → {range.to}</th>
                <th className="num">Current</th>
                {p && <th className="num">{p.from} → {p.to}</th>}
                {p && <th className="num">Change</th>}
              </tr>
            </thead>
            <tbody>
              <Row label="Gross sales (ex tax)" cur={c.grossSales} prev={p?.grossSales} />
              <Row label="Less: discounts" cur={-c.discounts} prev={p ? -p.discounts : undefined} cls="indent" />
              <Row label="Less: refunds (net of tax)" cur={-c.refunds} prev={p ? -p.refunds : undefined} cls="indent" />
              <Row label="Net sales" cur={c.netSales} prev={p?.netSales} cls="sub" />
              <Row label="Cost of goods (inventory consumed)" cur={-c.cogs} prev={p ? -p.cogs : undefined} cls="indent" />
              <Row label="Wastage" cur={-c.wastage} prev={p ? -p.wastage : undefined} cls="indent" />
              <Row label="Gross profit" cur={c.grossProfit} prev={p?.grossProfit} cls="sub" />
              {cats.map((name) => (
                <Row key={name} label={name} cur={-catAmt(c, name)} prev={p ? -catAmt(p, name) : undefined} cls="indent" />
              ))}
              <Row label="Payroll (finalised, incl. employer PF/ESI)" cur={-c.payroll} prev={p ? -p.payroll : undefined} cls="indent" />
              <Row label="Net profit" cur={c.netProfit} prev={p?.netProfit} cls="sub" />
            </tbody>
          </table>
          <p className="hint">
            GST collected on sales ({inr(c.taxCollected)}) is a liability and excluded. Expenses exclude claimable GST input credit. Payroll counts
            finalised runs, spread evenly across the days of their month.
          </p>
        </>
      )}
    </>
  );
}

// ---------- Day book ----------

const KIND_LABEL: Record<string, string> = {
  SALE: "Sale",
  REFUND: "Refund",
  EXPENSE: "Expense",
  CASH_IN: "Cash in",
  CASH_OUT: "Cash out",
  ADVANCE: "Salary advance",
  GIFT_CARD_SALE: "Gift card sold",
  PAYROLL: "Payroll",
};

export function DayBookView({ outletId }: { outletId: string }) {
  const [date, setDate] = useState(todayIst());
  const [book, setBook] = useState<DayBookDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    hrApi
      .dayBook(outletId, date, date)
      .then((b) => (setBook(b), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load day book"));
  }, [outletId, date]);

  return (
    <>
      <div className="hr-subnav">
        <button className="text-btn" onClick={() => setDate(addDays(date, -1))}>← Prev day</button>
        <input type="date" value={date} max={todayIst()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button className="text-btn" disabled={date >= todayIst()} onClick={() => setDate(addDays(date, 1))}>Next day →</button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {book && (
        <>
          <div className="inv-stats">
            <div className="stat"><span className="stat-label">Money in</span><span className="stat-value seg-good">{inr(book.totals.inflow)}</span></div>
            <div className="stat"><span className="stat-label">Money out</span><span className="stat-value">{inr(book.totals.outflow)}</span></div>
            <div className="stat"><span className="stat-label">Net</span><span className="stat-value">{inr(book.totals.net)}</span></div>
            {book.byMode.map((m) => (
              <div key={m.mode} className="stat"><span className="stat-label">{m.mode.replace("_", " ")}</span><span className="stat-value">{inr(m.net)}</span></div>
            ))}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Particulars</th>
                <th>Mode</th>
                <th className="num">In</th>
                <th className="num">Out</th>
              </tr>
            </thead>
            <tbody>
              {book.entries.map((e, i) => (
                <tr key={i}>
                  <td className="mono faint">{timeIst(e.at)}</td>
                  <td>{KIND_LABEL[e.kind] ?? e.kind}</td>
                  <td>{e.description}{e.ref && <span className="faint mono"> · {e.ref}</span>}</td>
                  <td className="faint">{e.mode.replace("_", " ")}</td>
                  <td className="num mono">{e.inflow ? inr(e.inflow) : ""}</td>
                  <td className="num mono">{e.outflow ? inr(e.outflow) : ""}</td>
                </tr>
              ))}
              {book.entries.length === 0 && <tr><td colSpan={6} className="empty">Nothing recorded on this day.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
