"use client";

import { useMemo, useState } from "react";
import type { OrderDto } from "@stello/shared";
import { posApi as api } from "@/lib/pos-api";

const rupee = (n: number) => `₹${n.toFixed(2)}`;

/**
 * Split a running bill into checks — equally, or by assigning each line's
 * quantity to a check. Every check then settles on its own bill number.
 */
export function SplitDialog({
  order,
  onClose,
  onDone,
}: {
  order: OrderDto;
  onClose: () => void;
  onDone: (order: OrderDto) => void;
}) {
  const lines = order.items.filter((i) => !i.isComboComponent);
  const [mode, setMode] = useState<"EQUAL" | "ITEMS">("EQUAL");
  const [parts, setParts] = useState(2);
  const [checks, setChecks] = useState(2);
  // assign[lineId][checkIndex] = quantity on that check; everything starts on check 1.
  const [assign, setAssign] = useState<Record<string, number[]>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, [l.quantity, ...Array(7).fill(0)]])),
  );
  const [discount, setDiscount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = (lineId: string, check: number, delta: number) =>
    setAssign((prev) => {
      const row = [...prev[lineId]];
      const line = lines.find((l) => l.id === lineId)!;
      const assignedElsewhere = row.reduce((s, q, i) => (i === check || i >= checks ? s : s + q), 0);
      row[check] = Math.max(0, Math.min(line.quantity - assignedElsewhere, row[check] + delta));
      return { ...prev, [lineId]: row };
    });

  const checkTotals = useMemo(
    () =>
      Array.from({ length: checks }, (_, c) =>
        lines.reduce((s, l) => s + (assign[l.id]?.[c] ?? 0) * l.unitPrice, 0),
      ),
    [assign, checks, lines],
  );
  const unassigned = lines.filter(
    (l) => (assign[l.id] ?? []).slice(0, checks).reduce((s, q) => s + q, 0) !== l.quantity,
  );
  const emptyCheck = checkTotals.some((t, c) => lines.every((l) => (assign[l.id]?.[c] ?? 0) === 0) && t === 0);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const discountAmount = discount > 0 ? discount : undefined;
      const res =
        mode === "EQUAL"
          ? await api.split(order.id, { mode: "EQUAL", parts, discountAmount })
          : await api.split(order.id, {
              mode: "ITEMS",
              discountAmount,
              checks: Array.from({ length: checks }, (_, c) => ({
                lines: lines
                  .filter((l) => (assign[l.id]?.[c] ?? 0) > 0)
                  .map((l) => ({ orderItemId: l.id, quantity: assign[l.id][c] })),
              })),
            });
      onDone(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not split the bill");
      setBusy(false);
    }
  };

  const ready = mode === "EQUAL" || (unassigned.length === 0 && !emptyCheck);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal ops-modal wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Split bill</h2>
            <span className="settle-sub">
              {order.tableName ?? order.orderType.replace("_", " ")} · {rupee(order.total)}
            </span>
          </div>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="seg">
            <button className={mode === "EQUAL" ? "on" : ""} onClick={() => setMode("EQUAL")}>
              Equal parts
            </button>
            <button className={mode === "ITEMS" ? "on" : ""} onClick={() => setMode("ITEMS")}>
              By items
            </button>
          </div>

          {mode === "EQUAL" ? (
            <div className="ops-equal">
              <span className="opt-label">Number of checks</span>
              <div className="qty-stepper">
                <button onClick={() => setParts((p) => Math.max(2, p - 1))}>–</button>
                <span>{parts}</span>
                <button onClick={() => setParts((p) => Math.min(20, p + 1))}>+</button>
              </div>
              <p className="co-msg">
                About {rupee(order.total / parts)} each. Every item is shared; exact paise are balanced across checks and
                tax is computed per check.
              </p>
            </div>
          ) : (
            <div className="ops-lines">
              <div className="ops-check-head">
                <span className="opt-label">Assign items</span>
                <div className="qty-stepper small">
                  <button onClick={() => setChecks((c) => Math.max(2, c - 1))}>–</button>
                  <span>{checks} checks</span>
                  <button onClick={() => setChecks((c) => Math.min(8, c + 1))}>+</button>
                </div>
              </div>
              <div className="split-grid" style={{ gridTemplateColumns: `minmax(120px, 1.4fr) repeat(${checks}, minmax(74px, 1fr))` }}>
                <span />
                {Array.from({ length: checks }, (_, c) => (
                  <span key={c} className="split-col-head">
                    Check {c + 1}
                    <small>{rupee(checkTotals[c])}</small>
                  </span>
                ))}
                {lines.map((l) => (
                  <div key={l.id} className="split-row" style={{ display: "contents" }}>
                    <span className={`ops-line-name ${unassigned.includes(l) ? "warn" : ""}`}>
                      {l.itemName}
                      <small>
                        {l.quantity} × {rupee(l.unitPrice)}
                      </small>
                    </span>
                    {Array.from({ length: checks }, (_, c) => (
                      <span key={c} className="bl-stepper split-cell">
                        <button onClick={() => move(l.id, c, -1)}>–</button>
                        <span>{assign[l.id]?.[c] ?? 0}</span>
                        <button onClick={() => move(l.id, c, +1)}>+</button>
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              <p className="co-msg">Amounts before tax, service charge and discounts.</p>
              {unassigned.length > 0 && (
                <p className="co-msg bad">Assign every item: {unassigned.map((l) => l.itemName).join(", ")}</p>
              )}
            </div>
          )}

          <div className="ss-row discount-row">
            <span>Bill discount (shared pro rata)</span>
            <input
              type="number"
              min={0}
              max={order.subtotal}
              value={discount || ""}
              placeholder="0"
              onChange={(e) => setDiscount(Number(e.target.value) || 0)}
            />
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button className="btn-primary grow" onClick={submit} disabled={busy || !ready}>
            {busy ? "Splitting…" : `Split into ${mode === "EQUAL" ? parts : checks} checks`}
          </button>
        </footer>
      </div>
    </div>
  );
}
