// Render KOTs, bills and test pages into a device-neutral PrintDoc: a list of
// already-laid-out lines plus a few graphic ops (QR, barcode, cut, drawer).
// One PrintDoc then encodes to ESC/POS bytes (thermal) or HTML (browser print),
// so both delivery paths share every layout decision.

import { fromPaise, toPaise } from "../money";
import { EscPosEncoder, type Align, type BarcodeType } from "./escpos";
import type { Codepage } from "./codepages";
import { charsPerLine, columns, formatAmount, formatDateTime, leftRight, wrap, type PaperWidth } from "./layout";
import type { BillDto, BillTaxLineDto, KotTicketDto, PrintPayload, TestPageDto } from "./types";

export type PrintOp =
  | {
      op: "text";
      text: string;
      align?: Align;
      bold?: boolean;
      invert?: boolean;
      /** Width × height multiplier. Width 2 halves the characters per line. */
      size?: [1 | 2, 1 | 2];
    }
  | { op: "rule"; char?: string }
  | { op: "qr"; data: string; size?: number }
  | { op: "barcode"; data: string; type: BarcodeType }
  | { op: "feed"; lines: number }
  | { op: "cut" }
  | { op: "drawer" };

export interface PrintDoc {
  paperWidth: PaperWidth;
  /** Characters per line at 1× width. */
  width: number;
  ops: PrintOp[];
}

export interface RenderOptions {
  paperWidth: PaperWidth;
  timeZone?: string;
}

class DocBuilder {
  readonly width: number;
  readonly ops: PrintOp[] = [];
  constructor(readonly paperWidth: PaperWidth) {
    this.width = charsPerLine(paperWidth);
  }
  text(text: string, style: Omit<Extract<PrintOp, { op: "text" }>, "op" | "text"> = {}) {
    this.ops.push({ op: "text", text, ...style });
    return this;
  }
  /** Wrapped paragraph, honouring a double-width size. */
  para(text: string, style: Omit<Extract<PrintOp, { op: "text" }>, "op" | "text"> = {}) {
    const w = style.size?.[0] === 2 ? Math.floor(this.width / 2) : this.width;
    for (const line of wrap(text, w)) this.text(line, style);
    return this;
  }
  lines(lines: string[], style: Omit<Extract<PrintOp, { op: "text" }>, "op" | "text"> = {}) {
    for (const line of lines) this.text(line, style);
    return this;
  }
  rule(char = "-") {
    this.ops.push({ op: "rule", char });
    return this;
  }
  push(op: PrintOp) {
    this.ops.push(op);
    return this;
  }
  build(): PrintDoc {
    return { paperWidth: this.paperWidth, width: this.width, ops: this.ops };
  }
}

const ORDER_TYPE_LABEL = { DINE_IN: "Dine-in", TAKEAWAY: "Takeaway", DELIVERY: "Delivery" } as const;

// ---------- KOT ----------

export function renderKot(t: KotTicketDto, opts: RenderOptions): PrintDoc {
  const d = new DocBuilder(opts.paperWidth);
  const W = d.width;
  if (t.cancelled) d.para("*** CANCELLED ***", { align: "center", bold: true, invert: true, size: [2, 2] });
  d.para(`KOT #${t.kotNumber}`, { align: "center", bold: true, size: [2, 2] });
  if (t.reprint) d.text("REPRINT", { align: "center", bold: true, invert: true });
  const where = t.tableName ? `Table ${t.tableName}` : ORDER_TYPE_LABEL[t.orderType];
  d.para(where, { align: "center", bold: true, size: [2, 1] });
  if (t.tableName) d.text(ORDER_TYPE_LABEL[t.orderType], { align: "center" });
  if (t.stationName) d.para(`Station: ${t.stationName}`, { align: "center", bold: true });
  d.rule();
  d.lines(leftRight(t.orderRef ? `Ref: ${t.orderRef}` : "", formatDateTime(t.createdAt, opts.timeZone), W));
  const meta = [t.source && t.source !== "POS" ? `Via: ${t.source === "SCAN" ? "Scan & Order" : "Online"}` : null,
    t.staffName ? `By: ${t.staffName}` : null, t.customerName ? `Cust: ${t.customerName}` : null].filter(Boolean) as string[];
  for (const m of meta) d.para(m);
  d.rule();
  // Item rows: quantity column then the name, in double height for legibility.
  const nameW = W - 5;
  let totalQty = 0;
  for (const item of t.items) {
    totalQty += item.quantity;
    const qty = `${t.cancelled ? "-" : ""}${item.quantity}`;
    const name = item.variationName ? `${item.name} (${item.variationName})` : item.name;
    d.lines(columns([{ text: qty, width: 4, align: "right" }, { text: name, width: nameW }]), { bold: true, size: [1, 2] });
    if (item.comboName) d.lines(columns([{ text: "", width: 4 }, { text: `[${item.comboName}]`, width: nameW }]));
    for (const addon of item.addons) d.lines(columns([{ text: "", width: 4 }, { text: `+ ${addon}`, width: nameW }]));
    if (item.note) d.lines(columns([{ text: "", width: 4 }, { text: `>> ${item.note}`, width: nameW }]), { bold: true });
  }
  d.rule();
  d.lines(leftRight(`Items: ${t.items.length}`, `Qty: ${totalQty}`, W));
  if (t.cancelled) d.text("STOP / DO NOT PREPARE", { align: "center", bold: true });
  return d.push({ op: "feed", lines: 3 }).push({ op: "cut" }).build();
}

// ---------- Bill ----------

const MODE_LABEL: Record<string, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI", WALLET: "Wallet", OTHER: "Other" };

export function renderBill(b: BillDto, opts: RenderOptions & { openDrawer?: boolean }): PrintDoc {
  const d = new DocBuilder(opts.paperWidth);
  const W = d.width;
  if (opts.openDrawer) d.push({ op: "drawer" });
  d.para(b.brandName, { align: "center", bold: true, size: [2, 2] });
  if (b.outletName && b.outletName !== b.brandName) d.para(b.outletName, { align: "center", bold: true });
  if (b.address) d.para(b.address, { align: "center" });
  for (const h of b.headerLines) if (h.trim()) d.para(h, { align: "center" });
  if (b.gstin) d.text(`GSTIN: ${b.gstin}`, { align: "center" });
  if (b.fssaiNumber) d.text(`FSSAI Lic. No: ${b.fssaiNumber}`, { align: "center" });
  d.rule();
  const title = b.provisional ? "PRO-FORMA / NOT A TAX INVOICE" : b.gstin ? "TAX INVOICE" : "BILL OF SUPPLY";
  d.para(title, { align: "center", bold: true });
  if (b.reprint) d.text("DUPLICATE", { align: "center", bold: true, invert: true });
  d.lines(leftRight(b.billNumber ? `Bill: ${b.billNumber}` : "Bill: (unsettled)", formatDateTime(b.createdAt, opts.timeZone), W));
  const where = b.tableName ? `Table ${b.tableName} · ${ORDER_TYPE_LABEL[b.orderType]}` : ORDER_TYPE_LABEL[b.orderType];
  d.lines(leftRight(where, b.cashierName ? `By: ${b.cashierName}` : "", W));
  if (b.customerName || b.customerPhone) d.para(`Customer: ${[b.customerName, b.customerPhone].filter(Boolean).join(" · ")}`);
  d.rule();

  // Item table. 80mm: Item | Qty | Rate | Amount. 58mm drops the Rate column.
  const wide = W >= 48;
  const cols = wide
    ? { name: W - 4 - 9 - 10 - 3, qty: 4, rate: 9, amt: 10 }
    : { name: W - 4 - 9 - 2, qty: 4, rate: 0, amt: 9 };
  const row = (name: string, qty: string, rate: string, amt: string) =>
    columns(
      wide
        ? [
            { text: name, width: cols.name },
            { text: qty, width: cols.qty, align: "right" },
            { text: rate, width: cols.rate, align: "right" },
            { text: amt, width: cols.amt, align: "right" },
          ]
        : [
            { text: name, width: cols.name },
            { text: qty, width: cols.qty, align: "right" },
            { text: amt, width: cols.amt, align: "right" },
          ],
    );
  d.lines(row("Item", "Qty", "Rate", "Amount"), { bold: true });
  d.rule();
  let totalQty = 0;
  for (const item of b.items) {
    if (item.isComboComponent) {
      d.lines(columns([{ text: "", width: 2 }, { text: `> ${item.name}`, width: cols.name - 2 }]));
      continue;
    }
    totalQty += item.quantity;
    const name = item.variationName ? `${item.name} (${item.variationName})` : item.name;
    d.lines(row(name, String(item.quantity), formatAmount(item.unitPrice), formatAmount(item.lineTotal)));
    for (const addon of item.addons) d.lines(columns([{ text: "", width: 2 }, { text: `+ ${addon}`, width: cols.name - 2 }]));
  }
  d.rule();

  const money = (label: string, amount: number) => d.lines(leftRight(label, formatAmount(amount), W));
  money("Subtotal", b.subtotal);
  for (const disc of b.discounts) if (disc.amount) money(disc.label, -disc.amount);
  if (b.serviceCharge) money("Service charge", b.serviceCharge);
  if (b.discounts.some((x) => x.amount) || b.serviceCharge) money("Taxable value", b.taxableValue);
  for (const t of b.taxLines) money(`${t.label} @${trimRate(t.ratePercent)}%`, t.amount);
  if (b.roundOff) money("Round off", b.roundOff);
  d.rule("=");
  d.lines(leftRight("TOTAL", `Rs. ${formatAmount(b.total)}`, W), { bold: true, size: [1, 2] });
  d.rule("=");
  d.lines(leftRight(`Items: ${b.items.filter((i) => !i.isComboComponent).length}`, `Qty: ${totalQty}`, W));
  if (b.payments.length) {
    d.text("Paid by", { bold: true });
    for (const p of b.payments) money(`  ${MODE_LABEL[p.mode] ?? p.mode}`, p.amount);
  }
  if (b.upiQr) {
    d.text("Scan to pay with any UPI app", { align: "center" });
    d.push({ op: "qr", data: b.upiQr, size: opts.paperWidth === 58 ? 5 : 6 });
  }
  if (b.footerLines.length) d.rule();
  for (const f of b.footerLines) if (f.trim()) d.para(f, { align: "center" });
  return d.push({ op: "feed", lines: 3 }).push({ op: "cut" }).build();
}

const trimRate = (r: number) => (Number.isInteger(r) ? String(r) : String(Math.round(r * 100) / 100));

// ---------- Test page ----------

export function renderTestPage(t: TestPageDto, opts: RenderOptions): PrintDoc {
  const d = new DocBuilder(opts.paperWidth);
  const W = d.width;
  d.para("TEST PRINT", { align: "center", bold: true, size: [2, 2] });
  d.para(t.printerName, { align: "center", bold: true });
  d.para(t.outletName, { align: "center" });
  d.rule();
  d.lines(leftRight("Connection", t.connection, W));
  d.lines(leftRight("Paper", `${t.paperWidth}mm / ${W} cols`, W));
  d.lines(leftRight("Code page", t.codepage, W));
  d.lines(leftRight("Sent", formatDateTime(t.requestedAt, opts.timeZone), W));
  d.rule();
  d.text("1234567890".repeat(Math.ceil(W / 10)).slice(0, W));
  d.text("Normal  ", {}).text("Bold", { bold: true }).text("Inverted", { invert: true });
  d.text("Centered", { align: "center" }).text("Right", { align: "right" });
  d.para("Double size", { size: [2, 2] });
  d.para("Accents: café crème naïve");
  d.push({ op: "barcode", data: "STELLO-TEST", type: "CODE128" });
  d.push({ op: "qr", data: "https://kitchens.stellotechs.com", size: 5 });
  d.para("If this prints cleanly, you're set.", { align: "center" });
  return d.push({ op: "feed", lines: 3 }).push({ op: "cut" }).build();
}

// ---------- Dispatch ----------

export function renderPayload(
  payload: PrintPayload,
  opts: RenderOptions & { openDrawer?: boolean },
): PrintDoc {
  switch (payload.kind) {
    case "KOT":
      return renderKot(payload.ticket, opts);
    case "BILL":
      return renderBill(payload.bill, opts);
    case "TEST":
      return renderTestPage(payload.test, opts);
    case "DRAWER":
      return { paperWidth: opts.paperWidth, width: charsPerLine(opts.paperWidth), ops: [{ op: "drawer" }] };
  }
}

// ---------- ESC/POS encoding ----------

/** Encode a PrintDoc to printer bytes. Every job starts with ESC @ and the code page. */
export function encodePrintDoc(doc: PrintDoc, options: { codepage?: Codepage; copies?: number } = {}): Uint8Array {
  const e = new EscPosEncoder();
  const copies = Math.max(1, options.copies ?? 1);
  for (let c = 0; c < copies; c++) {
    e.initialize().codepage(options.codepage ?? "CP437");
    for (const op of doc.ops) {
      switch (op.op) {
        case "text": {
          const [w, h] = op.size ?? [1, 1];
          e.align(op.align ?? "left");
          if (op.bold) e.bold(true);
          if (op.invert) e.invert(true);
          if (w !== 1 || h !== 1) e.size(w, h);
          e.line(op.text);
          if (w !== 1 || h !== 1) e.size(1, 1);
          if (op.invert) e.invert(false);
          if (op.bold) e.bold(false);
          break;
        }
        case "rule":
          e.align("left").rule(doc.width, op.char ?? "-");
          break;
        case "qr":
          e.align("center").qrcode(op.data, { size: op.size }).newline().align("left");
          break;
        case "barcode":
          e.align("center").barcode(op.data, op.type).newline().align("left");
          break;
        case "feed":
          e.feed(op.lines);
          break;
        case "cut":
          e.cut("partial");
          break;
        case "drawer":
          // Kick only once per job, not per copy.
          if (c === 0) e.pulse(0, 100, 200);
          break;
      }
    }
  }
  return e.encode();
}

// ---------- HTML (browser print) ----------

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A self-contained HTML document for printing a PrintDoc from a browser onto
 * 58/80mm roll paper. Lines are monospace and pre-laid-out, so columns match the
 * thermal output. QR codes are emitted as `<img data-qr="…">` placeholders the
 * host page fills (it owns the QR library); barcodes print as their text.
 */
export function printDocToHtml(doc: PrintDoc, options: { title?: string } = {}): string {
  // Printable width ≈ paper − ~6mm margins; size the font so `width` chars fit it.
  const printableMm = doc.paperWidth === 58 ? 48 : 72;
  const fontMm = (printableMm / doc.width / 0.6).toFixed(3);
  const body: string[] = [];
  for (const op of doc.ops) {
    switch (op.op) {
      case "text": {
        const [w, h] = op.size ?? [1, 1];
        const cls = [
          "l",
          op.bold ? "b" : "",
          op.invert ? "i" : "",
          w === 2 && h === 2 ? "x2" : h === 2 ? "tall" : "",
          `a-${op.align ?? "left"}`,
        ]
          .filter(Boolean)
          .join(" ");
        body.push(`<div class="${cls}"><span>${escapeHtml(op.text) || "&nbsp;"}</span></div>`);
        break;
      }
      case "rule":
        body.push(`<div class="l">${escapeHtml((op.char ?? "-").repeat(doc.width))}</div>`);
        break;
      case "qr":
        body.push(`<div class="qr"><img alt="QR" data-qr="${escapeHtml(op.data)}" /></div>`);
        break;
      case "barcode":
        body.push(`<div class="l a-center">${escapeHtml(op.data)}</div>`);
        break;
      case "feed":
        body.push(`<div class="feed" style="height:${op.lines}em"></div>`);
        break;
      case "cut":
        body.push(`<div class="cut"></div>`);
        break;
      case "drawer":
        break;
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(options.title ?? "Print")}</title><style>
@page{size:${doc.paperWidth}mm auto;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:#000}
.slip{width:${printableMm}mm;margin:0 auto;padding:2mm 0;font-family:"Courier New",Courier,monospace;font-size:${fontMm}mm;line-height:1.2}
.l{white-space:pre;overflow:hidden}
.b{font-weight:700}
.i span{background:#000;color:#fff}
.x2{font-size:2em;line-height:1.15}
.tall span{display:inline-block;transform:scaleY(2);transform-origin:top left;margin-bottom:1.2em}
.a-center{text-align:center}.a-right{text-align:right}
.qr{text-align:center;padding:1mm 0}.qr img{width:${doc.paperWidth === 58 ? 30 : 38}mm;height:auto}
.cut{border-bottom:1px dashed #999;margin-top:2mm;page-break-after:always}
</style></head><body><div class="slip">${body.join("")}</div></body></html>`;
}

// ---------- GST tax lines ----------

/**
 * Split an order's tax into printable CGST/SGST (intra-state) or IGST lines per
 * GST rate. Each rate's share of the (discounted) taxable value is computed in
 * integer paise, and the largest group absorbs the rounding residue so the
 * lines always sum to the order's stored `taxAmount` exactly.
 */
export function billTaxLines(params: {
  lines: { lineTotal: number; taxRatePercent: number }[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  interState: boolean;
}): BillTaxLineDto[] {
  const subtotalPaise = toPaise(params.subtotal);
  const taxablePaise = subtotalPaise - toPaise(params.discountAmount);
  const taxPaise = toPaise(params.taxAmount);
  const groups = new Map<number, number>(); // rate → raw tax paise (pre-discount)
  for (const l of params.lines) {
    if (!l.taxRatePercent) continue;
    groups.set(l.taxRatePercent, (groups.get(l.taxRatePercent) ?? 0) + (toPaise(l.lineTotal) * l.taxRatePercent) / 100);
  }
  if (!groups.size || taxPaise <= 0 || subtotalPaise <= 0) return [];
  const rates = [...groups.keys()].sort((a, b) => a - b);
  const shares = new Map(rates.map((r) => [r, Math.round((groups.get(r)! * taxablePaise) / subtotalPaise)]));
  const residue = taxPaise - [...shares.values()].reduce((s, v) => s + v, 0);
  const biggest = rates.reduce((best, r) => (shares.get(r)! > shares.get(best)! ? r : best), rates[0]);
  shares.set(biggest, shares.get(biggest)! + residue);
  const out: BillTaxLineDto[] = [];
  for (const rate of rates) {
    const paise = shares.get(rate)!;
    if (paise <= 0) continue;
    if (params.interState) {
      out.push({ label: "IGST", ratePercent: rate, amount: fromPaise(paise) });
    } else {
      const half = Math.floor(paise / 2);
      out.push({ label: "CGST", ratePercent: rate / 2, amount: fromPaise(half) });
      out.push({ label: "SGST", ratePercent: rate / 2, amount: fromPaise(paise - half) });
    }
  }
  return out;
}
