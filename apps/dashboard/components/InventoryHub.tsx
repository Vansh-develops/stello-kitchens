"use client";

import { useState } from "react";
import { InventoryTab } from "./InventoryTab";
import { PurchaseOrdersPanel } from "./procurement/PurchaseOrdersPanel";
import { ReceivingPanel } from "./procurement/ReceivingPanel";
import { VendorsPanel } from "./procurement/VendorsPanel";
import { StocktakePanel } from "./procurement/StocktakePanel";
import { ReorderPanel } from "./procurement/ReorderPanel";
import { ForecastPanel } from "./procurement/ForecastPanel";
import "./procurement/procurement.css";

const SUBTABS = [
  ["stock", "Stock"],
  ["pos", "Purchase orders"],
  ["receiving", "Receiving"],
  ["vendors", "Vendors & payables"],
  ["stocktake", "Stocktake"],
  ["reorder", "Reorder"],
  ["forecast", "Forecast"],
] as const;
type SubTab = (typeof SUBTABS)[number][0];

/** Inventory with procurement sub-tabs; "Stock" is the original inventory screen. */
export function InventoryHub({ outletId }: { outletId: string }) {
  const [sub, setSub] = useState<SubTab>("stock");
  // Lets one panel hand off to another (e.g. "Receive" on a PO opens Receiving).
  const [focusPo, setFocusPo] = useState<string | null>(null);

  return (
    <>
      <div className="inv-subnav">
        <div className="seg" role="tablist" aria-label="Inventory sections">
          {SUBTABS.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={sub === key} className={sub === key ? "on" : ""} onClick={() => setSub(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {sub === "stock" && <InventoryTab outletId={outletId} />}
      {sub === "pos" && (
        <PurchaseOrdersPanel
          outletId={outletId}
          onReceive={(id) => {
            setFocusPo(id);
            setSub("receiving");
          }}
        />
      )}
      {sub === "receiving" && <ReceivingPanel outletId={outletId} focusPoId={focusPo} onFocusDone={() => setFocusPo(null)} />}
      {sub === "vendors" && <VendorsPanel outletId={outletId} />}
      {sub === "stocktake" && <StocktakePanel outletId={outletId} />}
      {sub === "reorder" && <ReorderPanel outletId={outletId} onCreated={() => setSub("pos")} />}
      {sub === "forecast" && <ForecastPanel outletId={outletId} />}
    </>
  );
}
