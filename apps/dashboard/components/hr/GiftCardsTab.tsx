"use client";

import { useCallback, useEffect, useState } from "react";
import "./hr.css";
import type { GiftCardDetailDto, GiftCardDto, IssueGiftCardInput } from "@stello/shared";
import { hrApi, inr } from "@/lib/hr-api";

const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function GiftCardsTab({ outletId }: { outletId: string }) {
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<GiftCardDto[]>([]);
  const [detail, setDetail] = useState<GiftCardDetailDto | null>(null);
  const [issued, setIssued] = useState<GiftCardDto | null>(null);
  const [form, setForm] = useState<IssueGiftCardInput>({ amount: 1000, paymentMode: "CASH", expiresOn: null, customerName: "", customerPhone: "" });
  const [voidReason, setVoidReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setCards(await hrApi.giftCards(q.trim() || undefined));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load gift cards");
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => void reload(), 250);
    return () => clearTimeout(t);
  }, [reload]);

  const issue = async () => {
    try {
      const card = await hrApi.issueGiftCard(outletId, {
        ...form,
        expiresOn: form.expiresOn || null,
        customerName: form.customerName || null,
        customerPhone: form.customerPhone || null,
      });
      setIssued(card);
      setForm({ ...form, customerName: "", customerPhone: "" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not issue card");
    }
  };

  const liability = cards.filter((c) => c.status === "ACTIVE" && !c.expired).reduce((s, c) => s + c.balance, 0);

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Gift cards &amp; store credit</h1>
        <input placeholder="Search code, phone or name" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
      </div>
      <p className="hint wide">
        Sell prepaid gift cards and track refund store credit. Cards work at every outlet and are redeemed at the POS as a payment mode.
        Unredeemed balance is a liability, not revenue — sales are recognised when the card is spent.
      </p>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <div className="inv-stats">
        <div className="stat"><span className="stat-label">Cards shown</span><span className="stat-value">{cards.length}</span></div>
        <div className="stat"><span className="stat-label">Outstanding balance</span><span className="stat-value">{inr(liability)}</span></div>
      </div>

      <div className="hr-grid-2">
        <table className="data-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Type</th>
              <th>Customer</th>
              <th className="num">Value</th>
              <th className="num">Balance</th>
              <th>Expires</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id} className={c.status !== "ACTIVE" || c.expired ? "low" : ""}>
                <td className="mono strong">{c.code}</td>
                <td className="faint">{c.kind === "STORE_CREDIT" ? "Store credit" : "Gift card"}</td>
                <td>{c.customerName ?? c.customerPhone ?? <span className="faint">—</span>}</td>
                <td className="num mono">{inr(c.initialValue)}</td>
                <td className="num mono strong">{inr(c.balance)}</td>
                <td className="faint">{c.expiresOn ?? "Never"}</td>
                <td>
                  <span className={`status-pill ${c.status === "VOID" ? "bad" : c.expired ? "muted" : "good"}`}>
                    {c.status === "VOID" ? "Void" : c.expired ? "Expired" : "Active"}
                  </span>
                </td>
                <td className="row-actions">
                  <button className="text-btn" onClick={() => void hrApi.giftCard(c.id).then(setDetail).catch((e) => setError(e.message))}>Ledger</button>
                </td>
              </tr>
            ))}
            {cards.length === 0 && <tr><td colSpan={8} className="empty">No gift cards yet.</td></tr>}
          </tbody>
        </table>

        <aside className="side-card">
          <h3>Sell a gift card</h3>
          <div className="hr-form">
            <label className="field">Amount ₹<input type="number" min={1} value={form.amount || ""} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) || 0 })} /></label>
            <label className="field">
              Paid by
              <select value={form.paymentMode} onChange={(e) => setForm({ ...form, paymentMode: e.target.value as IssueGiftCardInput["paymentMode"] })}>
                <option value="CASH">Cash</option>
                <option value="CARD">Card</option>
                <option value="UPI">UPI</option>
                <option value="COMPLIMENTARY">Complimentary</option>
              </select>
            </label>
            <label className="field">Expires on<input type="date" value={form.expiresOn ?? ""} onChange={(e) => setForm({ ...form, expiresOn: e.target.value || null })} /></label>
            <label className="field">Customer phone<input value={form.customerPhone ?? ""} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} inputMode="tel" /></label>
            <label className="field wide">Customer name<input value={form.customerName ?? ""} onChange={(e) => setForm({ ...form, customerName: e.target.value })} /></label>
          </div>
          <button className="btn-primary sm" style={{ marginTop: 10 }} disabled={form.amount < 1} onClick={issue}>Issue card</button>
          {issued && (
            <div className="hr-note" style={{ marginTop: 12 }}>
              Issued <strong className="mono">{issued.code}</strong> for {inr(issued.initialValue)}. Give this code to the customer.
            </div>
          )}
        </aside>
      </div>

      {detail && (
        <div className="modal-scrim" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <div>
                <h2 className="mono">{detail.code}</h2>
                <span className="settle-sub">
                  {detail.kind === "STORE_CREDIT" ? "Store credit" : "Gift card"} · balance {inr(detail.balance)} of {inr(detail.initialValue)}
                </span>
              </div>
              <button className="modal-x" onClick={() => setDetail(null)}>✕</button>
            </header>
            <div className="modal-body">
              <table className="mini-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>When</th>
                    <th style={{ textAlign: "left" }}>Type</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th style={{ textAlign: "right" }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.ledger.map((t) => (
                    <tr key={t.id}>
                      <td className="faint">{date(t.createdAt)}</td>
                      <td>{t.type.replace("_", " ").toLowerCase()}{t.paymentMode ? ` · ${t.paymentMode.toLowerCase()}` : ""}{t.note ? ` · ${t.note}` : ""}</td>
                      <td className="num mono">{inr(t.amount)}</td>
                      <td className="num mono">{inr(t.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.status === "ACTIVE" && (
                <section className="editor-section">
                  <h3>Void card</h3>
                  <p className="hint">Voiding forfeits the remaining balance. Use for lost or fraudulent cards; refund any cash separately.</p>
                  <div className="field-row">
                    <input placeholder="Reason" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                    <button
                      className="btn-primary sm"
                      disabled={voidReason.trim().length < 3}
                      onClick={async () => {
                        try {
                          await hrApi.voidGiftCard(detail.id, voidReason.trim());
                          setDetail(await hrApi.giftCard(detail.id));
                          setVoidReason("");
                          await reload();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Could not void");
                        }
                      }}
                    >
                      Void
                    </button>
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
