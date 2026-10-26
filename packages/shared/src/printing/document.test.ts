import { describe, expect, it } from "vitest";
import { billTaxLines, encodePrintDoc, printDocToHtml, renderBill, renderKot, renderTestPage, type PrintDoc } from "./document";
import { columns, formatAmount, formatDateTime, leftRight, wrap } from "./layout";
import type { BillDto, KotTicketDto } from "./types";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const textLines = (doc: PrintDoc) =>
  doc.ops.flatMap((o) => (o.op === "text" ? [o.text] : o.op === "rule" ? [(o.char ?? "-").repeat(doc.width)] : []));

const maxWidthOk = (doc: PrintDoc) =>
  doc.ops.every((o) => o.op !== "text" || o.text.length <= (o.size?.[0] === 2 ? doc.width / 2 : doc.width));

const ticket = (over: Partial<KotTicketDto> = {}): KotTicketDto => ({
  outletName: "Koramangala",
  kotNumber: 42,
  orderType: "DINE_IN",
  tableName: "T4",
  stationName: "Tandoor",
  orderRef: "B-12",
  source: "POS",
  customerName: null,
  staffName: "Ravi",
  createdAt: "2026-10-26T08:35:00.000Z", // 14:05 IST
  items: [
    { name: "Butter Naan", variationName: null, quantity: 2, addons: ["Garlic"], note: "extra crispy" },
    { name: "Paneer Tikka with a very long descriptive name", variationName: "Full", quantity: 1, addons: [], note: null },
  ],
  reprint: false,
  cancelled: false,
  ...over,
});

const bill = (over: Partial<BillDto> = {}): BillDto => ({
  brandName: "Stello Kitchens",
  outletName: "Koramangala",
  address: "80 Feet Rd, Koramangala, Bengaluru",
  gstin: "29ABCDE1234F1Z5",
  fssaiNumber: "12345678901234",
  headerLines: [],
  billNumber: "B-7",
  provisional: false,
  orderType: "DINE_IN",
  tableName: "T4",
  customerName: null,
  customerPhone: null,
  cashierName: "Ravi",
  createdAt: "2026-10-26T08:35:00.000Z",
  items: [
    { name: "Butter Chicken", variationName: null, addons: ["Extra gravy"], quantity: 2, unitPrice: 320, lineTotal: 640, isComboComponent: false },
    { name: "Lunch Combo", variationName: null, addons: [], quantity: 1, unitPrice: 250, lineTotal: 250, isComboComponent: false },
    { name: "Dal Makhani", variationName: null, addons: [], quantity: 1, unitPrice: 0, lineTotal: 0, isComboComponent: true },
  ],
  subtotal: 890,
  discounts: [{ label: "Coupon SAVE10", amount: 89 }],
  serviceCharge: null,
  taxableValue: 801,
  taxLines: [
    { label: "CGST", ratePercent: 2.5, amount: 20.02 },
    { label: "SGST", ratePercent: 2.5, amount: 20.03 },
  ],
  taxTotal: 40.05,
  roundOff: null,
  total: 841.05,
  payments: [{ mode: "CASH", amount: 841.05 }],
  upiQr: null,
  footerLines: ["Thank you! Visit again"],
  reprint: false,
  ...over,
});

describe("layout", () => {
  it("wraps words and hard-breaks long ones", () => {
    expect(wrap("Paneer butter masala", 10)).toEqual(["Paneer", "butter", "masala"]);
    expect(wrap("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
    expect(wrap("  ", 5)).toEqual([""]);
  });

  it("lays out columns with per-cell wrapping and alignment", () => {
    expect(
      columns([
        { text: "Chicken Biryani", width: 8 },
        { text: "2", width: 3, align: "right" },
        { text: "480.00", width: 8, align: "right" },
      ]),
    ).toEqual(["Chicken    2   480.00", "Biryani"]);
  });

  it("aligns label/value pairs and falls back to wrapping", () => {
    expect(leftRight("Subtotal", "890.00", 20)).toEqual(["Subtotal      890.00"]);
    const wrapped = leftRight("A very long discount label", "-89.00", 20);
    expect(wrapped.every((l) => l.length <= 20)).toBe(true);
    expect(wrapped.at(-1)!.endsWith("-89.00")).toBe(true);
  });

  it("formats amounts with Indian grouping and dates in IST", () => {
    expect(formatAmount(1234567.5)).toBe("12,34,567.50");
    expect(formatAmount(999)).toBe("999.00");
    expect(formatAmount(-89)).toBe("-89.00");
    expect(formatDateTime("2026-10-26T08:35:00.000Z")).toBe("26-10-2026 14:05");
  });
});

describe("KOT render", () => {
  it.each([58, 80] as const)("fits %smm paper and carries the essentials", (paper) => {
    const doc = renderKot(ticket(), { paperWidth: paper });
    expect(doc.width).toBe(paper === 58 ? 32 : 48);
    expect(maxWidthOk(doc)).toBe(true);
    const text = textLines(doc).join("\n");
    expect(text).toContain("KOT #42");
    expect(text).toContain("Table T4");
    expect(text).toContain("Station: Tandoor");
    expect(text).toContain("26-10-2026 14:05");
    expect(text).toContain("+ Garlic");
    expect(text).toContain(">> extra crispy");
    expect(text).toMatch(/Qty: 3/);
    expect(text).not.toContain("REPRINT");
    expect(doc.ops.at(-1)).toEqual({ op: "cut" });
  });

  it("marks reprints and cancellation tickets", () => {
    const re = textLines(renderKot(ticket({ reprint: true }), { paperWidth: 80 })).join("\n");
    expect(re).toContain("REPRINT");
    const cancel = renderKot(ticket({ cancelled: true }), { paperWidth: 80 });
    const text = textLines(cancel).join("\n");
    expect(text).toContain("*** CANCELLED ***");
    expect(text).toMatch(/^\s+-2 Butter Naan/m);
    expect(text).toContain("STOP / DO NOT PREPARE");
  });

  it("puts the quantity in a fixed 4-char column", () => {
    const doc = renderKot(ticket(), { paperWidth: 58 });
    const naan = textLines(doc).find((l) => l.includes("Butter Naan"))!;
    expect(naan).toBe("   2 Butter Naan");
  });
});

describe("bill render", () => {
  it("80mm uses Item/Qty/Rate/Amount columns exactly 48 wide", () => {
    const doc = renderBill(bill(), { paperWidth: 80 });
    expect(maxWidthOk(doc)).toBe(true);
    const lines = textLines(doc);
    const header = lines.find((l) => l.startsWith("Item"))!;
    expect(header).toBe("Item                    Qty      Rate     Amount");
    const row = lines.find((l) => l.startsWith("Butter Chicken"))!;
    expect(row).toBe("Butter Chicken            2    320.00     640.00");
    expect(row.length).toBe(48);
  });

  it("58mm drops the Rate column", () => {
    const lines = textLines(renderBill(bill(), { paperWidth: 58 }));
    expect(lines.find((l) => l.startsWith("Item"))).toBe("Item               Qty    Amount");
    expect(lines.find((l) => l.startsWith("Butter Chicken"))).toBe("Butter Chicken       2    640.00");
  });

  it("prints GST identity, discounts, tax lines, total and payments", () => {
    const text = textLines(renderBill(bill(), { paperWidth: 80 })).join("\n");
    expect(text).toContain("GSTIN: 29ABCDE1234F1Z5");
    expect(text).toContain("FSSAI Lic. No: 12345678901234");
    expect(text).toContain("TAX INVOICE");
    expect(text).toMatch(/Coupon SAVE10\s+-89\.00/);
    expect(text).toMatch(/Taxable value\s+801\.00/);
    expect(text).toMatch(/CGST @2\.5%\s+20\.02/);
    expect(text).toMatch(/SGST @2\.5%\s+20\.03/);
    expect(text).toMatch(/TOTAL\s+Rs\. 841\.05/);
    expect(text).toMatch(/Cash\s+841\.05/);
    expect(text).toContain("> Dal Makhani");
    expect(text).toContain("+ Extra gravy");
    expect(text).not.toContain("Service charge");
    expect(text).not.toContain("Round off");
    expect(text).not.toContain("DUPLICATE");
  });

  it("shows service charge, round off, IGST, duplicate and pro-forma when present", () => {
    const text = textLines(
      renderBill(
        bill({
          serviceCharge: 40,
          roundOff: -0.05,
          taxLines: [{ label: "IGST", ratePercent: 5, amount: 40.05 }],
          reprint: true,
          provisional: true,
          billNumber: null,
        }),
        { paperWidth: 58 },
      ),
    ).join("\n");
    expect(text).toMatch(/Service charge\s+40\.00/);
    expect(text).toMatch(/Round off\s+-0\.05/);
    expect(text).toMatch(/IGST @5%\s+40\.05/);
    expect(text).toContain("DUPLICATE");
    expect(text).toContain("PRO-FORMA");
  });

  it("adds a UPI QR and a leading drawer kick when asked", () => {
    const doc = renderBill(bill({ upiQr: "upi://pay?pa=a@b&am=1.00" }), { paperWidth: 80, openDrawer: true });
    expect(doc.ops[0]).toEqual({ op: "drawer" });
    expect(doc.ops.some((o) => o.op === "qr" && o.data.startsWith("upi://"))).toBe(true);
  });
});

describe("encodePrintDoc", () => {
  it("starts with init + code page, ends with a partial cut", () => {
    const doc = renderKot(ticket(), { paperWidth: 80 });
    const out = Array.from(encodePrintDoc(doc, { codepage: "CP858" }));
    expect(out.slice(0, 5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 19]);
    expect(out.slice(-3)).toEqual([0x1d, 0x56, 1]);
  });

  it("kicks the drawer once even with multiple copies", () => {
    const doc = renderBill(bill(), { paperWidth: 80, openDrawer: true });
    const out = encodePrintDoc(doc, { copies: 2 });
    const h = hex(out);
    expect(h.split("1b70003264").length - 1).toBe(1);
    expect(h.split("1b40").length - 1).toBe(2);
    expect(h.split("1d5601").length - 1).toBe(2);
  });

  it("wraps styled text with matching on/off bytes", () => {
    const doc: PrintDoc = { paperWidth: 80, width: 48, ops: [{ op: "text", text: "A", bold: true, size: [2, 2], align: "center" }] };
    expect(Array.from(encodePrintDoc(doc)).slice(5)).toEqual([
      0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x11, 0x41, 0x0a, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0,
    ]);
  });

  it("renders a test page with barcode and QR", () => {
    const doc = renderTestPage(
      { printerName: "Counter", outletName: "Kor", connection: "NETWORK", paperWidth: 58, codepage: "CP437", requestedAt: "2026-10-26T08:35:00.000Z" },
      { paperWidth: 58 },
    );
    expect(maxWidthOk(doc)).toBe(true);
    const h = hex(encodePrintDoc(doc));
    expect(h).toContain("1d6b49"); // GS k CODE128
    expect(h).toContain("1d286b"); // GS ( k QR
  });
});

describe("printDocToHtml", () => {
  it("emits a paper-sized, escaped, monospace document with QR placeholders", () => {
    const html = printDocToHtml(renderBill(bill({ customerName: "<script>", upiQr: "upi://pay?pa=x" }), { paperWidth: 58 }));
    expect(html).toContain("@page{size:58mm auto");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('data-qr="upi://pay?pa=x"');
    expect(html).toContain("Butter Chicken       2    640.00");
  });
});

describe("billTaxLines", () => {
  it("splits each rate into CGST/SGST summing exactly to the stored tax", () => {
    const lines = billTaxLines({
      lines: [
        { lineTotal: 640, taxRatePercent: 5 },
        { lineTotal: 250, taxRatePercent: 18 },
        { lineTotal: 99.99, taxRatePercent: 0 },
      ],
      subtotal: 989.99,
      discountAmount: 100,
      taxAmount: 73.6,
      interState: false,
    });
    expect(lines.map((l) => `${l.label}@${l.ratePercent}`)).toEqual(["CGST@2.5", "SGST@2.5", "CGST@9", "SGST@9"]);
    const sum = Math.round(lines.reduce((s, l) => s + l.amount * 100, 0));
    expect(sum).toBe(7360);
  });

  it("uses IGST for inter-state and returns nothing without tax", () => {
    expect(
      billTaxLines({ lines: [{ lineTotal: 100, taxRatePercent: 5 }], subtotal: 100, discountAmount: 0, taxAmount: 5, interState: true }),
    ).toEqual([{ label: "IGST", ratePercent: 5, amount: 5 }]);
    expect(billTaxLines({ lines: [], subtotal: 0, discountAmount: 0, taxAmount: 0, interState: false })).toEqual([]);
  });
});
