import { useMemo, useState } from "react";
import type { MenuItemDto, OrderItemInput } from "@petpooja/shared";

type Line = OrderItemInput & {
  variationName: string | null;
  addonNames: string[];
  unitPrice: number;
};

const rupee = (n: number) => `₹${n.toFixed(2)}`;

export function ItemDialog({
  item,
  onClose,
  onAdd,
}: {
  item: MenuItemDto;
  onClose: () => void;
  onAdd: (line: Line) => void;
}) {
  const [variationId, setVariationId] = useState<string | null>(
    item.variations[0]?.id ?? null,
  );
  const [addonIds, setAddonIds] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [quantity, setQuantity] = useState(1);

  const toggleAddon = (groupMax: number, groupAddonIds: string[], id: string) => {
    setAddonIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const inGroup = groupAddonIds.filter((a) => next.has(a));
        if (inGroup.length >= groupMax) {
          // replace oldest in group when at max
          next.delete(inGroup[0]);
        }
        next.add(id);
      }
      return next;
    });
  };

  const { unitPrice, variationName, addonNames } = useMemo(() => {
    const variation = item.variations.find((v) => v.id === variationId);
    let price = variation ? variation.price : item.price;
    const names: string[] = [];
    for (const g of item.addonGroups) {
      for (const a of g.addons) {
        if (addonIds.has(a.id)) {
          price += a.price;
          names.push(a.name);
        }
      }
    }
    return { unitPrice: price, variationName: variation?.name ?? null, addonNames: names };
  }, [item, variationId, addonIds]);

  const submit = () => {
    onAdd({
      itemId: item.id,
      variationId: variationId ?? undefined,
      addonIds: [...addonIds],
      quantity,
      note: note.trim() || undefined,
      variationName,
      addonNames,
      unitPrice,
    });
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal item-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <span className={`veg-dot ${item.isVeg ? "veg" : "nonveg"}`} />
            <h2>{item.name}</h2>
          </div>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {item.variations.length > 0 && (
            <div className="opt-group">
              <span className="opt-label">Variation</span>
              <div className="opt-chips">
                {item.variations.map((v) => (
                  <button
                    key={v.id}
                    className={`opt-chip ${variationId === v.id ? "on" : ""}`}
                    onClick={() => setVariationId(v.id)}
                  >
                    {v.name}
                    <em>{rupee(v.price)}</em>
                  </button>
                ))}
              </div>
            </div>
          )}

          {item.addonGroups.map((g) => (
            <div key={g.id} className="opt-group">
              <span className="opt-label">
                {g.name}
                <small>up to {g.maxSelect}</small>
              </span>
              <div className="opt-chips">
                {g.addons.map((a) => (
                  <button
                    key={a.id}
                    className={`opt-chip ${addonIds.has(a.id) ? "on" : ""}`}
                    onClick={() =>
                      toggleAddon(g.maxSelect, g.addons.map((x) => x.id), a.id)
                    }
                  >
                    {a.name}
                    <em>+{rupee(a.price)}</em>
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
