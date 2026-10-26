import type { BillDto, KotTicketDto, KotTicketItemDto, PrintSettingsDto } from "@stello/shared";
import { billTaxLines, fromPaise, toPaise } from "@stello/shared";
import type { Prisma } from "@prisma/client";

// Pure builders: database rows in, print DTOs out. Kept free of Nest/Prisma
// calls so the routing and tax rules are easy to read and test.

type OrderForPrint = Prisma.OrderGetPayload<{
  include: { table: true; items: { include: { addons: true } }; payments: true };
}>;
type KotForPrint = Prisma.KotGetPayload<{ include: { items: { include: { addons: true } } } }>;

const N = (d: Prisma.Decimal | number) => Number(d);
const stateOf = (gstin?: string | null) => (gstin && gstin.length >= 2 ? gstin.slice(0, 2) : null);

export function settingsDto(row: { fssaiNumber: string | null; headerLines: unknown; footerLines: unknown; upiQrOnBill: boolean } | null): PrintSettingsDto {
  const lines = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    fssaiNumber: row?.fssaiNumber ?? null,
    headerLines: lines(row?.headerLines),
    footerLines: row ? lines(row.footerLines) : ["Thank you! Visit again."],
    upiQrOnBill: row?.upiQrOnBill ?? true,
  };
}

/**
 * The slice of a KOT a printer should print. A printer with no station mapping
 * gets every item; a mapped printer gets only its stations' items (items with
 * no station only go to unmapped printers). Returns null when nothing applies.
 */
export function kotTicketFor(params: {
  kot: KotForPrint;
  order: OrderForPrint;
  outletName: string;
  stationNames: Map<string, string>;
  stationIds: string[];
  staffName: string | null;
  source: KotTicketDto["source"];
  reprint: boolean;
  cancelled: boolean;
}): KotTicketDto | null {
  const { kot, order } = params;
  const mapped = params.stationIds.length > 0;
  const lines = kot.items.filter((i) => !mapped || (i.stationId !== null && params.stationIds.includes(i.stationId)));
  if (lines.length === 0) return null;
  const comboNames = new Map(
    order.items.filter((i) => i.comboGroupId && !i.isComboComponent).map((i) => [i.comboGroupId!, i.itemName]),
  );
  const items: KotTicketItemDto[] = lines.map((i) => ({
    name: i.itemName,
    variationName: i.variationName,
    quantity: i.quantity,
    addons: i.addons.map((a) => a.name),
    note: i.note,
    comboName: i.isComboComponent && i.comboGroupId ? (comboNames.get(i.comboGroupId) ?? null) : null,
  }));
  const stations = [...new Set(lines.map((i) => i.stationId).filter((s): s is string => !!s))];
  return {
    outletName: params.outletName,
    kotNumber: kot.kotNumber,
    orderType: order.orderType as KotTicketDto["orderType"],
    tableName: order.table?.name ?? null,
    stationName: stations.length === 1 ? (params.stationNames.get(stations[0]) ?? null) : null,
    orderRef: order.billNumber ?? `#${order.id.slice(-6).toUpperCase()}`,
    source: params.source,
    customerName: order.orderType === "DINE_IN" ? null : order.customerName,
    staffName: params.staffName,
    createdAt: kot.createdAt.toISOString(),
    items,
    reprint: params.reprint,
    cancelled: params.cancelled,
  };
}

/** UPI deep link in the same shape the payments module renders on screen. */
export function upiLink(vpa: string, payeeName: string, amount: number, ref: string): string {
  const q = new URLSearchParams({ pa: vpa, pn: payeeName, am: amount.toFixed(2), cu: "INR", tn: `Bill ${ref}` });
  return `upi://pay?${q.toString()}`;
}

export function billFor(params: {
  order: OrderForPrint;
  outlet: { name: string; address: string | null; gstin: string | null; placeOfSupply: string | null; upiVpa: string | null };
  brandName: string;
  settings: PrintSettingsDto;
  buyerGstin: string | null;
  cashierName: string | null;
  reprint: boolean;
}): BillDto {
  const { order, outlet, settings } = params;
  const provisional = order.status !== "SETTLED";
  const subtotal = N(order.subtotal);
  const discount = N(order.discountAmount);
  const taxAmount = N(order.taxAmount);
  const total = N(order.total);
  const sellerState = outlet.placeOfSupply ?? stateOf(outlet.gstin);
  const buyerState = stateOf(params.buyerGstin);
  const interState = !!buyerState && !!sellerState && buyerState !== sellerState;
  const parents = order.items.filter((i) => !i.isComboComponent);
  // Order items print in punch order, each combo followed by its components.
  const items: BillDto["items"] = [];
  for (const i of parents) {
    items.push({
      name: i.itemName,
      variationName: i.variationName,
      addons: i.addons.map((a) => a.name),
      quantity: i.quantity,
      unitPrice: N(i.unitPrice),
      lineTotal: N(i.lineTotal),
      isComboComponent: false,
    });
    if (i.comboGroupId) {
      for (const c of order.items.filter((x) => x.isComboComponent && x.comboGroupId === i.comboGroupId)) {
        items.push({ name: c.itemName, variationName: c.variationName, addons: [], quantity: c.quantity, unitPrice: 0, lineTotal: 0, isComboComponent: true });
      }
    }
  }
  const taxLines = billTaxLines({
    lines: order.items.map((i) => ({ lineTotal: N(i.lineTotal), taxRatePercent: N(i.taxRate) })),
    subtotal,
    discountAmount: discount,
    taxAmount,
    interState,
  });
  const ref = order.billNumber ?? order.id.slice(-6).toUpperCase();
  return {
    brandName: params.brandName,
    outletName: outlet.name,
    address: outlet.address,
    gstin: outlet.gstin,
    fssaiNumber: settings.fssaiNumber,
    headerLines: settings.headerLines,
    billNumber: provisional ? null : order.billNumber,
    provisional,
    orderType: order.orderType as BillDto["orderType"],
    tableName: order.table?.name ?? null,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    cashierName: params.cashierName,
    createdAt: order.createdAt.toISOString(),
    items,
    subtotal,
    discounts: discount > 0 ? [{ label: order.couponCode ? `Discount (${order.couponCode})` : "Discount", amount: discount }] : [],
    serviceCharge: null,
    taxableValue: fromPaise(toPaise(subtotal) - toPaise(discount)),
    taxLines,
    taxTotal: taxAmount,
    roundOff: null,
    total,
    payments: order.payments.map((p) => ({ mode: p.mode, amount: N(p.amount) })),
    upiQr: provisional && settings.upiQrOnBill && outlet.upiVpa && total > 0 ? upiLink(outlet.upiVpa, params.brandName, total, ref) : null,
    footerLines: settings.footerLines,
    reprint: params.reprint,
  };
}
