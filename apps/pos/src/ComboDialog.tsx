import { useMemo, useState } from "react";
import type { ComboDto } from "@petpooja/shared";

// What a configured combo contributes to the cart.
export type ComboLine = {
  comboId: string;
  quantity: number;
  selections: { slotId: string; itemId: string }[];
  componentNames: string[];
  unitPrice: number;
  note?: string;
};

const rupee = (n: number) => `₹${n.toFixed(2)}`;

export function ComboDialog({
  combo,
  onClose,
  onAdd,
}: {
  combo: ComboDto;
  onClose: () => void;
  onAdd: (line: ComboLine) => void;
}) {
  // Default each slot to its flagged default (or first option).
  const [chosen, setChosen] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const slot of combo.slots) {
      const def = slot.options.find((o) => o.isDefault) ?? slot.options[0];
      if (def) init[slot.id] = def.itemId;
    }
    return init;
  });
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");

  const { unitPrice, componentNames } = useMemo(() => {
    let price = combo.price;
    const names: string[] = [];
    for (const slot of combo.slots) {
      const opt = slot.options.find((o) => o.itemId === chosen[slot.id]);
      if (opt) {
        price += opt.priceDelta;
        names.push(opt.name);
      }
    }
    return { unitPrice: price, componentNames: names };
  }, [combo, chosen]);

  const submit = () =>
    onAdd({
      comboId: combo.id,
      quantity,
      selections: combo.slots.map((s) => ({ slotId: s.id, itemId: chosen[s.id] })),
      componentNames,
      unitPrice,
      note: note.trim() || undefined,
    });

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal item-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <span className={`veg-dot ${combo.isVeg ? "veg" : "nonveg"}`} />
            <h2>{combo.name}</h2>
          </div>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {combo.slots.map((slot) => (
            <div key={slot.id} className="opt-group">
              <span className="opt-label">{slot.name}</span>
              <div className="opt-chips">
                {slot.options.map((o) => (
                  <button
                    key={o.id}
                    className={`opt-chip ${chosen[slot.id] === o.itemId ? "on" : ""} ${!o.inStock ? "disabled" : ""}`}
                    disabled={!o.inStock}
                    onClick={() => setChosen((prev) => ({ ...prev, [slot.id]: o.itemId }))}
                  >
                    {o.name}
                    {o.priceDelta > 0 && <em>+{rupee(o.priceDelta)}</em>}
                    {!o.inStock && <em>86'd</em>}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div className="opt-group">
            <span className="opt-label">Note</span>
            <input
              className="note-input"
              placeholder="e.g. no onion, less spicy"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <footer className="modal-foot">
          <div className="qty-stepper">
            <button onClick={() => setQuantity((q) => Math.max(1, q - 1))}>–</button>
            <span>{quantity}</span>
            <button onClick={() => setQuantity((q) => q + 1)}>+</button>
          </div>
          <button className="btn-primary grow" onClick={submit}>
            Add · {rupee(unitPrice * quantity)}
          </button>
        </footer>
      </div>
    </div>
  );
}
