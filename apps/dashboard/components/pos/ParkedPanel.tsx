"use client";

import { useState } from "react";
import type { ParkedCartDto } from "@stello/shared";
import { posApi as api } from "@/lib/pos-api";

const rupee = (n: number) => `₹${n.toFixed(2)}`;
const age = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

/** Held carts for the outlet; resuming claims one for this terminal. */
export function ParkedPanel({
  parked,
  onClose,
  onResume,
  onChanged,
}: {
  parked: ParkedCartDto[];
  onClose: () => void;
  onResume: (cart: ParkedCartDto) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal ops-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Held orders</h2>
            <span className="settle-sub">{parked.length} parked · any terminal can resume</span>
          </div>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          {parked.length === 0 && <p className="co-msg">Nothing on hold.</p>}
          {parked.map((p) => (
            <div key={p.id} className="parked-row">
              <div className="parked-main">
                <strong>{p.label}</strong>
                <small>
                  {p.tableName ?? p.orderType.replace("_", " ").toLowerCase()} · {p.itemCount} item(s)
                  {p.orderId ? " · adds to running bill" : ""} · {age(p.createdAt)} ago
                  {p.parkedBy ? ` · ${p.parkedBy}` : ""}
                </small>
                <small className="parked-lines">
                  {p.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}
                </small>
              </div>
              <span className="ops-amt">{rupee(p.amount)}</span>
              <div className="parked-actions">
                <button
                  className="co-apply"
                  disabled={busy === p.id}
                  onClick={() =>
                    void act(p.id, async () => {
                      if (!confirm(`Discard “${p.label}”?`)) return;
                      await api.discardParked(p.id);
                      onChanged();
                    })
                  }
                >
                  Discard
                </button>
                <button
                  className="btn-primary"
                  disabled={busy === p.id}
                  onClick={() => void act(p.id, async () => onResume(await api.resumeParked(p.id)))}
                >
                  Resume
                </button>
              </div>
            </div>
          ))}
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
