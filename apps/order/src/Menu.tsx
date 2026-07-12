import { useEffect, useMemo, useState } from "react";
import type { ComboDto, MenuItemDto, PublicMenuDto } from "@stello/shared";
import { api } from "./api";
import { ThemeProvider } from "./ThemeProvider";

// Common display shape + a discriminator that carries what the submit payload needs.
type CartLine = {
  key: string;
  name: string;
  variationName?: string;
  addonNames: string[];
  unitPrice: number;
  qty: number;
} & (
  | { kind: "item"; itemId: string; variationId?: string; addonIds: string[] }
  | { kind: "combo"; comboId: string; selections: { slotId: string; itemId: string }[] }
);

const rupee = (n: number) => `₹${n.toFixed(0)}`;

// A stable identity for a configured line so re-adding the same choice stacks.
const lineKey = (itemId: string, variationId: string | undefined, addonIds: string[]) =>
  `${itemId}|${variationId ?? ""}|${[...addonIds].sort().join(",")}`;

export function Menu({ mode, token }: { mode: "table" | "kiosk"; token: string }) {
  const [menu, setMenu] = useState<PublicMenuDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [configuring, setConfiguring] = useState<MenuItemDto | null>(null);
  const [configuringCombo, setConfiguringCombo] = useState<ComboDto | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [phase, setPhase] = useState<"browse" | "review" | "placed">("browse");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [requestToken, setRequestToken] = useState<string | null>(null);
  const [status, setStatus] = useState<"PENDING" | "ACCEPTED" | "REJECTED">("PENDING");
  const [tokenNumber, setTokenNumber] = useState<number | null>(null);
  const [waiterPaged, setWaiterPaged] = useState(false);

  useEffect(() => {
    (mode === "table" ? api.tableMenu(token) : api.kioskMenu(token))
      .then((m) => {
        setMenu(m);
        setActiveCat(m.categories[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the menu"));
  }, [mode, token]);

  // Poll the request's fate once placed.
  useEffect(() => {
    if (!requestToken || status !== "PENDING") return;
    const t = setInterval(async () => {
      try {
        const s = await api.status(requestToken);
        setStatus(s.status);
        setTokenNumber(s.tokenNumber);
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => clearInterval(t);
  }, [requestToken, status]);

  const count = cart.reduce((s, l) => s + l.qty, 0);
  const total = cart.reduce((s, l) => s + l.unitPrice * l.qty, 0);

  const addLine = (item: MenuItemDto, variationId?: string, addonIds: string[] = []) => {
    const variation = item.variations.find((v) => v.id === variationId);
    const allAddons = item.addonGroups.flatMap((g) => g.addons);
    const addons = addonIds.map((id) => allAddons.find((a) => a.id === id)!).filter(Boolean);
    const unitPrice =
      (variation ? variation.price : item.price) + addons.reduce((s, a) => s + a.price, 0);
    const key = lineKey(item.id, variationId, addonIds);
    setCart((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) return prev.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l));
      return [
        ...prev,
        {
          kind: "item",
          key,
          itemId: item.id,
          name: item.name,
          variationId,
          variationName: variation?.name,
          addonIds,
          addonNames: addons.map((a) => a.name),
          unitPrice,
          qty: 1,
        },
      ];
    });
  };

  const addComboLine = (combo: ComboDto, selections: { slotId: string; itemId: string }[]) => {
    let unitPrice = combo.price;
    const componentNames: string[] = [];
    for (const slot of combo.slots) {
      const sel = selections.find((s) => s.slotId === slot.id);
      const option = slot.options.find((o) => o.itemId === sel?.itemId);
      if (option) {
        unitPrice += option.priceDelta;
        componentNames.push(option.name);
      }
    }
    const key = `combo|${combo.id}|${selections.map((s) => s.itemId).sort().join(",")}`;
    setCart((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) return prev.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l));
      return [
        ...prev,
        { kind: "combo", key, comboId: combo.id, name: combo.name, selections, addonNames: componentNames, unitPrice, qty: 1 },
      ];
    });
  };

  const onAdd = (item: MenuItemDto) => {
    if (item.variations.length > 0 || item.addonGroups.length > 0) setConfiguring(item);
    else addLine(item);
  };

  const setQty = (key: string, delta: number) =>
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    );

  const place = async () => {
    if (!cart.length) return;
    const body = {
      items: cart
        .filter((l): l is Extract<CartLine, { kind: "item" }> => l.kind === "item")
        .map((l) => ({ itemId: l.itemId, variationId: l.variationId, addonIds: l.addonIds, quantity: l.qty })),
      combos: cart
        .filter((l): l is Extract<CartLine, { kind: "combo" }> => l.kind === "combo")
        .map((l) => ({ comboId: l.comboId, quantity: l.qty, selections: l.selections })),
      customerName: name.trim() || undefined,
      customerPhone: phone.trim() || undefined,
    };
    try {
      const res =
        mode === "table" ? await api.submitTable(token, body) : await api.submitKiosk(token, body);
      setRequestToken(res.requestToken);
      setPhase("placed");
      setCartOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not place your order");
    }
  };

  if (error && !menu)
    return (
      <ThemeProvider>
        <Splash title="Hmm." sub={error} />
      </ThemeProvider>
    );
  if (!menu)
    return (
      <ThemeProvider>
        <Splash title="Stello Kitchens" sub="Loading the menu…" />
      </ThemeProvider>
    );

  if (phase === "placed") {
    return (
      <ThemeProvider themeId={menu?.themeId}>
        <Confirmation
          status={status}
          tokenNumber={tokenNumber}
          outletName={menu.outletName}
          onDone={() => {
            setCart([]);
            setRequestToken(null);
            setStatus("PENDING");
            setTokenNumber(null);
            setPhase("browse");
          }}
        />
      </ThemeProvider>
    );
  }

  const cats = menu.categories.filter((c) => c.items.length > 0 || c.combos.length > 0);

  return (
    <ThemeProvider themeId={menu?.themeId}>
    <div className={`menu${mode === "kiosk" ? " menu-kiosk" : ""}`}>
      <header className="menu-head">
        <div className="brand-row">
          <span className="mark">Stello Kitchens</span>
          <span className="where">
            {mode === "table" ? `Table ${menu.tableName}` : "Takeaway"}
          </span>
        </div>
        <h1>What are you craving?</h1>
        {mode === "table" && (
          <button
            className="waiter"
            disabled={waiterPaged}
            onClick={() => api.callWaiter(token).then(() => setWaiterPaged(true)).catch(() => {})}
          >
            {waiterPaged ? "A server is on the way ✓" : "Call a server"}
          </button>
        )}
      </header>

      <nav className="cat-rail">
        {cats.map((c) => (
          <button
            key={c.id}
            className={c.id === activeCat ? "chip on" : "chip"}
            onClick={() => {
              setActiveCat(c.id);
              document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            {c.name}
          </button>
        ))}
      </nav>

      <div className="items">
        {cats.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} className="cat-block">
            <h2 className="cat-title">{c.name}</h2>
            {c.combos.map((combo) => (
              <article key={combo.id} className={combo.inStock ? "item combo" : "item off"}>
                <div className="item-main">
                  <span className={combo.isVeg ? "veg dot" : "nonveg dot"} aria-hidden />
                  <div>
                    <h3>
                      <span className="combo-chip">COMBO</span> {combo.name}
                    </h3>
                    <span className="price">{rupee(combo.price)}</span>
                    <span className="cust">{combo.slots.length} to choose</span>
                  </div>
                </div>
                {combo.inStock ? (
                  <button className="add" onClick={() => setConfiguringCombo(combo)}>
                    Add
                  </button>
                ) : (
                  <span className="sold">Sold out</span>
                )}
              </article>
            ))}
            {c.items.map((it) => (
              <article key={it.id} className={it.inStock ? "item" : "item off"}>
                <div className="item-main">
                  <span className={it.isVeg ? "veg dot" : "nonveg dot"} aria-hidden />
                  <div>
                    <h3>{it.name}</h3>
                    <span className="price">
                      {it.variations.length ? `from ${rupee(it.variations[0].price)}` : rupee(it.price)}
                    </span>
                    {it.addonGroups.length > 0 && <span className="cust">customisable</span>}
                  </div>
                </div>
                {it.inStock ? (
                  <button className="add" onClick={() => onAdd(it)}>
                    Add
                  </button>
                ) : (
                  <span className="sold">Sold out</span>
                )}
              </article>
            ))}
          </section>
        ))}
        <div className="foot-space" />
      </div>

      {count > 0 && (
        <button className="cart-bar" onClick={() => setCartOpen(true)}>
          <span>
            {count} item{count > 1 ? "s" : ""}
          </span>
          <span className="cart-cta">Review order · {rupee(total)}</span>
        </button>
      )}

      {configuring && (
        <Configurator
          item={configuring}
          onClose={() => setConfiguring(null)}
          onConfirm={(variationId, addonIds) => {
            addLine(configuring, variationId, addonIds);
            setConfiguring(null);
          }}
        />
      )}

      {configuringCombo && (
        <ComboConfigurator
          combo={configuringCombo}
          onClose={() => setConfiguringCombo(null)}
          onConfirm={(selections) => {
            addComboLine(configuringCombo, selections);
            setConfiguringCombo(null);
          }}
        />
      )}

      {cartOpen && (
        <div className="sheet-wrap" onClick={() => setCartOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" />
            <h2>Your order</h2>
            <div className="cart-lines">
              {cart.map((l) => (
                <div key={l.key} className="cart-line">
                  <div>
                    <span className="cl-name">{l.name}</span>
                    {(l.variationName || l.addonNames.length > 0) && (
                      <span className="cl-opts">
                        {[l.variationName, ...l.addonNames].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                  <div className="stepper">
                    <button onClick={() => setQty(l.key, -1)}>−</button>
                    <span>{l.qty}</span>
                    <button onClick={() => setQty(l.key, +1)}>+</button>
                  </div>
                  <span className="cl-price">{rupee(l.unitPrice * l.qty)}</span>
                </div>
              ))}
            </div>
            <div className="who">
              <input placeholder="Your name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
              <input
                placeholder="Phone (optional)"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            {error && <p className="err">{error}</p>}
            <button className="place" onClick={place}>
              Send to kitchen · {rupee(total)}
            </button>
            <p className="fineprint">A server will confirm your order before it's prepared.</p>
          </div>
        </div>
      )}
    </div>
    </ThemeProvider>
  );
}

function Configurator({
  item,
  onClose,
  onConfirm,
}: {
  item: MenuItemDto;
  onClose: () => void;
  onConfirm: (variationId: string | undefined, addonIds: string[]) => void;
}) {
  const [variationId, setVariationId] = useState<string | undefined>(item.variations[0]?.id);
  const [addonIds, setAddonIds] = useState<string[]>([]);

  const toggleAddon = (id: string, max: number, groupIds: string[]) =>
    setAddonIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      const inGroup = prev.filter((x) => groupIds.includes(x));
      if (max === 1) return [...prev.filter((x) => !groupIds.includes(x)), id];
      if (inGroup.length >= max) return prev;
      return [...prev, id];
    });

  const base = item.variations.find((v) => v.id === variationId)?.price ?? item.price;
  const allAddons = item.addonGroups.flatMap((g) => g.addons);
  const addonSum = addonIds.reduce((s, id) => s + (allAddons.find((a) => a.id === id)?.price ?? 0), 0);

  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <h2>{item.name}</h2>
        {item.variations.length > 0 && (
          <div className="opt-group">
            <span className="opt-label">Choose one</span>
            {item.variations.map((v) => (
              <label key={v.id} className="opt">
                <input type="radio" checked={variationId === v.id} onChange={() => setVariationId(v.id)} />
                <span>{v.name}</span>
                <span className="opt-price">₹{v.price.toFixed(0)}</span>
              </label>
            ))}
          </div>
        )}
        {item.addonGroups.map((g) => {
          const groupIds = g.addons.map((a) => a.id);
          return (
            <div key={g.id} className="opt-group">
              <span className="opt-label">
                {g.name}
                {g.maxSelect > 0 && <em> · up to {g.maxSelect}</em>}
              </span>
              {g.addons.map((a) => (
                <label key={a.id} className="opt">
                  <input
                    type="checkbox"
                    checked={addonIds.includes(a.id)}
                    onChange={() => toggleAddon(a.id, g.maxSelect || 99, groupIds)}
                  />
                  <span>{a.name}</span>
                  <span className="opt-price">+₹{a.price.toFixed(0)}</span>
                </label>
              ))}
            </div>
          );
        })}
        <button className="place" onClick={() => onConfirm(variationId, addonIds)}>
          Add · ₹{(base + addonSum).toFixed(0)}
        </button>
      </div>
    </div>
  );
}

function ComboConfigurator({
  combo,
  onClose,
  onConfirm,
}: {
  combo: ComboDto;
  onClose: () => void;
  onConfirm: (selections: { slotId: string; itemId: string }[]) => void;
}) {
  // Default each slot to its flagged default (or first in-stock option).
  const [chosen, setChosen] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const slot of combo.slots) {
      const def = slot.options.find((o) => o.isDefault) ?? slot.options[0];
      if (def) init[slot.id] = def.itemId;
    }
    return init;
  });

  const price = useMemo(() => {
    let p = combo.price;
    for (const slot of combo.slots) {
      const opt = slot.options.find((o) => o.itemId === chosen[slot.id]);
      if (opt) p += opt.priceDelta;
    }
    return p;
  }, [combo, chosen]);

  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <h2>
          <span className="combo-chip">COMBO</span> {combo.name}
        </h2>
        {combo.slots.map((slot) => (
          <div key={slot.id} className="opt-group">
            <span className="opt-label">{slot.name}</span>
            {slot.options.map((o) => (
              <label key={o.id} className={`opt ${!o.inStock ? "disabled" : ""}`}>
                <input
                  type="radio"
                  name={slot.id}
                  disabled={!o.inStock}
                  checked={chosen[slot.id] === o.itemId}
                  onChange={() => setChosen((p) => ({ ...p, [slot.id]: o.itemId }))}
                />
                <span>{o.name}{!o.inStock && " (sold out)"}</span>
                <span className="opt-price">{o.priceDelta > 0 ? `+₹${o.priceDelta.toFixed(0)}` : ""}</span>
              </label>
            ))}
          </div>
        ))}
        <button
          className="place"
          onClick={() => onConfirm(combo.slots.map((s) => ({ slotId: s.id, itemId: chosen[s.id] })))}
        >
          Add · ₹{price.toFixed(0)}
        </button>
      </div>
    </div>
  );
}

function Confirmation({
  status,
  tokenNumber,
  outletName,
  onDone,
}: {
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  tokenNumber: number | null;
  outletName: string;
  onDone: () => void;
}) {
  return (
    <div className={`confirm ${status.toLowerCase()}`}>
      <span className="mark">{outletName}</span>
      {status === "PENDING" && (
        <>
          <div className="pulse" />
          <h1>Sent to the counter</h1>
          <p>A server is confirming your order. Hang tight — this is usually quick.</p>
        </>
      )}
      {status === "ACCEPTED" && (
        <>
          <span className="token-label">Your token</span>
          <div className="token-ticket">{tokenNumber ?? "—"}</div>
          <h1>Order confirmed</h1>
          <p>We're preparing it now. Watch for your token on the screen.</p>
          <button className="again" onClick={onDone}>
            Order more
          </button>
        </>
      )}
      {status === "REJECTED" && (
        <>
          <h1>Order not confirmed</h1>
          <p>The counter couldn't take this order. Please check with a server.</p>
          <button className="again" onClick={onDone}>
            Start over
          </button>
        </>
      )}
    </div>
  );
}

function Splash({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="landing">
      <div className="mark">Stello Kitchens</div>
      <h1>{title}</h1>
      <p>{sub}</p>
    </div>
  );
}
