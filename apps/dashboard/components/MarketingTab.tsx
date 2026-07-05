"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CampaignDto, CouponDto, FeedbackDto } from "@petpooja/shared";
import { api } from "@/lib/api";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function MarketingTab({ outletId }: { outletId: string }) {
  const [coupons, setCoupons] = useState<CouponDto[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [feedback, setFeedback] = useState<FeedbackDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [newCoupon, setNewCoupon] = useState({ code: "", type: "FLAT", value: "", minOrder: "", maxDiscount: "" });
  const [newCampaign, setNewCampaign] = useState({ name: "", channel: "WHATSAPP", segment: "ALL", message: "" });

  const reload = useCallback(async () => {
    try {
      const [c, cp, f] = await Promise.all([api.coupons(outletId), api.campaigns(outletId), api.feedback(outletId)]);
      setCoupons(c);
      setCampaigns(cp);
      setFeedback(f);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load marketing");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setConfirmDelete(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const avgRating = useMemo(
    () => (feedback.length ? (feedback.reduce((s, f) => s + f.rating, 0) / feedback.length).toFixed(1) : "—"),
    [feedback],
  );

  const createCoupon = () =>
    run(async () => {
      await api.createCoupon(outletId, {
        code: newCoupon.code.trim().toUpperCase(),
        type: newCoupon.type as "FLAT" | "PERCENT",
        value: Number(newCoupon.value) || 0,
        minOrder: Number(newCoupon.minOrder) || 0,
        maxDiscount: newCoupon.maxDiscount ? Number(newCoupon.maxDiscount) : null,
        isActive: true,
      });
      setNewCoupon({ code: "", type: "FLAT", value: "", minOrder: "", maxDiscount: "" });
    });

  const createCampaign = () =>
    run(async () => {
      await api.createCampaign(outletId, {
        name: newCampaign.name.trim(),
        channel: newCampaign.channel as "SMS" | "WHATSAPP" | "EMAIL",
        segment: newCampaign.segment as "ALL" | "NEW" | "REGULAR" | "VIP" | "LAPSED",
        message: newCampaign.message.trim(),
      });
      setNewCampaign({ name: "", channel: "WHATSAPP", segment: "ALL", message: "" });
    });

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Marketing</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      <div className="mkt-grid">
        {/* Coupons */}
        <section className="mkt-col">
          <h2 className="mkt-h">Coupons</h2>
          <div className="coupon-list">
            {coupons.map((c) => (
              <div key={c.id} className={`coupon-card ${!c.isActive ? "off" : ""}`}>
                <div className="cc-main">
                  <span className="cc-code">{c.code}</span>
                  <span className="cc-desc">
                    {c.type === "PERCENT" ? `${c.value}% off` : `${money(c.value)} off`}
                    {c.minOrder > 0 && ` · min ${money(c.minOrder)}`}
                    {c.maxDiscount ? ` · cap ${money(c.maxDiscount)}` : ""}
                  </span>
                  <span className="cc-usage">used {c.usedCount}{c.usageLimit ? ` / ${c.usageLimit}` : ""}</span>
                </div>
                <div className="cc-actions">
                  <button
                    className={`chan-active ${c.isActive ? "on" : ""}`}
                    onClick={() => void run(() => api.setCouponActive(outletId, c.id, !c.isActive))}
                  >
                    {c.isActive ? "Active" : "Off"}
                  </button>
                  <button
                    className={`text-btn danger ${confirmDelete === c.id ? "armed" : ""}`}
                    onClick={() =>
                      confirmDelete === c.id ? void run(() => api.deleteCoupon(outletId, c.id)) : setConfirmDelete(c.id)
                    }
                  >
                    {confirmDelete === c.id ? "Confirm" : "Del"}
                  </button>
                </div>
              </div>
            ))}
            {coupons.length === 0 && <p className="empty">No coupons.</p>}
          </div>
          <div className="mkt-form">
            <div className="field-row">
              <input placeholder="CODE" value={newCoupon.code} onChange={(e) => setNewCoupon((p) => ({ ...p, code: e.target.value }))} />
              <select value={newCoupon.type} onChange={(e) => setNewCoupon((p) => ({ ...p, type: e.target.value }))}>
                <option value="FLAT">₹ Flat</option>
                <option value="PERCENT">% Percent</option>
              </select>
            </div>
            <div className="field-row">
              <input type="number" placeholder="Value" value={newCoupon.value} onChange={(e) => setNewCoupon((p) => ({ ...p, value: e.target.value }))} />
              <input type="number" placeholder="Min order" value={newCoupon.minOrder} onChange={(e) => setNewCoupon((p) => ({ ...p, minOrder: e.target.value }))} />
              <input type="number" placeholder="Max disc" value={newCoupon.maxDiscount} onChange={(e) => setNewCoupon((p) => ({ ...p, maxDiscount: e.target.value }))} />
            </div>
            <button className="btn-primary sm" disabled={!newCoupon.code.trim() || !newCoupon.value} onClick={createCoupon}>
              + Create coupon
            </button>
          </div>
        </section>

        {/* Campaigns */}
        <section className="mkt-col">
          <h2 className="mkt-h">Campaigns</h2>
          <div className="campaign-list">
            {campaigns.map((c) => (
              <div key={c.id} className="campaign-card">
                <div className="cmp-top">
                  <span className="cmp-name">{c.name}</span>
                  <span className={`status-pill ${c.status === "SENT" ? "good" : "muted"}`}>
                    {c.status === "SENT" ? `Sent · ${c.sentCount}` : "Draft"}
                  </span>
                </div>
                <div className="cmp-meta">
                  <span className="plat-badge">{c.channel}</span>
                  <span className="cmp-seg">→ {c.segment}</span>
                </div>
                <p className="cmp-msg">{c.message}</p>
                {c.status !== "SENT" && (
                  <button className="btn-primary sm" onClick={() => void run(() => api.sendCampaign(outletId, c.id))}>
                    Send now
                  </button>
                )}
              </div>
            ))}
            {campaigns.length === 0 && <p className="empty">No campaigns.</p>}
          </div>
          <div className="mkt-form">
            <input placeholder="Campaign name" value={newCampaign.name} onChange={(e) => setNewCampaign((p) => ({ ...p, name: e.target.value }))} />
            <div className="field-row">
              <select value={newCampaign.channel} onChange={(e) => setNewCampaign((p) => ({ ...p, channel: e.target.value }))}>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="SMS">SMS</option>
                <option value="EMAIL">Email</option>
              </select>
              <select value={newCampaign.segment} onChange={(e) => setNewCampaign((p) => ({ ...p, segment: e.target.value }))}>
                <option value="ALL">All</option>
                <option value="NEW">New</option>
                <option value="REGULAR">Regular</option>
                <option value="VIP">VIP</option>
                <option value="LAPSED">Lapsed</option>
              </select>
            </div>
            <textarea
              placeholder="Message…"
              rows={2}
              value={newCampaign.message}
              onChange={(e) => setNewCampaign((p) => ({ ...p, message: e.target.value }))}
            />
            <button className="btn-primary sm" disabled={!newCampaign.name.trim() || !newCampaign.message.trim()} onClick={createCampaign}>
              + Create campaign
            </button>
          </div>
        </section>

        {/* Feedback */}
        <section className="mkt-col">
          <h2 className="mkt-h">Feedback <span className="fb-avg">{avgRating}★ avg</span></h2>
          <div className="feedback-list">
            {feedback.map((f) => (
              <div key={f.id} className="feedback-card">
                <div className="fb-top">
                  <span className="fb-stars">{"★".repeat(f.rating)}<span className="fb-dim">{"★".repeat(5 - f.rating)}</span></span>
                  <span className="faint">{f.customerName ?? "Anonymous"}</span>
                </div>
                {f.comment && <p className="fb-comment">{f.comment}</p>}
              </div>
            ))}
            {feedback.length === 0 && <p className="empty">No feedback yet. It arrives via the QR-on-bill link.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
