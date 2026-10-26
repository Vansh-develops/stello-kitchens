import { z } from "zod";
import { CODEPAGES, type Codepage } from "./codepages";
import type { PaperWidth } from "./layout";

// ---------- Documents (what gets printed) ----------

export interface KotTicketItemDto {
  name: string;
  variationName: string | null;
  quantity: number;
  addons: string[];
  note: string | null;
  /** Set on combo components: the combo they belong to. */
  comboName?: string | null;
}

/** One kitchen order ticket, already sliced to the items a printer/station handles. */
export interface KotTicketDto {
  outletName: string;
  kotNumber: number;
  orderType: "DINE_IN" | "TAKEAWAY" | "DELIVERY";
  tableName: string | null;
  stationName: string | null;
  /** Bill number once settled, else a short order reference. */
  orderRef: string | null;
  source: "POS" | "SCAN" | "AGGREGATOR" | null;
  customerName: string | null;
  staffName: string | null;
  createdAt: string;
  items: KotTicketItemDto[];
  /** A reprint of a ticket the kitchen already has. */
  reprint: boolean;
  /** A cancellation ticket: the kitchen must STOP these items. */
  cancelled: boolean;
}

export interface BillItemDto {
  name: string;
  variationName: string | null;
  addons: string[];
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** Combo components print indented under their combo, without amounts. */
  isComboComponent: boolean;
}

export interface BillTaxLineDto {
  label: "CGST" | "SGST" | "IGST";
  ratePercent: number;
  amount: number;
}

/** A customer bill / GST tax invoice. Money in rupees (2dp), from integer paise. */
export interface BillDto {
  brandName: string;
  outletName: string;
  address: string | null;
  gstin: string | null;
  fssaiNumber: string | null;
  headerLines: string[];
  /** null for a provisional (pre-settlement) bill. */
  billNumber: string | null;
  provisional: boolean;
  orderType: "DINE_IN" | "TAKEAWAY" | "DELIVERY";
  tableName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  cashierName: string | null;
  createdAt: string;
  items: BillItemDto[];
  subtotal: number;
  discounts: { label: string; amount: number }[];
  /** Only printed when present (outlets that levy one). */
  serviceCharge: number | null;
  taxableValue: number;
  taxLines: BillTaxLineDto[];
  taxTotal: number;
  /** Only printed when non-zero. */
  roundOff: number | null;
  total: number;
  payments: { mode: string; amount: number }[];
  /** A UPI deep link rendered as a scan-to-pay QR (unpaid bills). */
  upiQr: string | null;
  footerLines: string[];
  /** Reprints are marked DUPLICATE, as GST practice expects. */
  reprint: boolean;
}

export interface TestPageDto {
  printerName: string;
  outletName: string;
  connection: PrinterConnection;
  paperWidth: PaperWidth;
  codepage: Codepage;
  requestedAt: string;
}

export type PrintPayload =
  | { kind: "KOT"; ticket: KotTicketDto }
  | { kind: "BILL"; bill: BillDto }
  | { kind: "TEST"; test: TestPageDto }
  | { kind: "DRAWER" };

export type PrintJobKind = PrintPayload["kind"];

// ---------- Printers ----------

export type PrinterConnection = "NETWORK" | "USB" | "BROWSER";
export const PrinterConnectionEnum = z.enum(["NETWORK", "USB", "BROWSER"]);

export interface PrinterDto {
  id: string;
  name: string;
  connection: PrinterConnection;
  host: string | null;
  port: number;
  /** USB/local device: a raw device path (/dev/usb/lp0) or Windows share (\\localhost\POS80). */
  usbPath: string | null;
  paperWidth: PaperWidth;
  codepage: Codepage;
  printKots: boolean;
  printBills: boolean;
  /** KOT routing: stations this printer serves. Empty = every station. */
  stationIds: string[];
  copies: number;
  autoPrintKot: boolean;
  autoPrintBill: boolean;
  drawerKick: boolean;
  isActive: boolean;
}

const hostRe = /^[A-Za-z0-9.-]+$/;

const PrinterFields = {
  name: z.string().trim().min(1).max(60),
  connection: PrinterConnectionEnum,
  host: z.string().trim().max(253).regex(hostRe, "Host must be an IP address or hostname").nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  usbPath: z.string().trim().max(200).nullable().optional(),
  paperWidth: z.union([z.literal(58), z.literal(80)]).optional(),
  codepage: z.enum(CODEPAGES as [Codepage, ...Codepage[]]).optional(),
  printKots: z.boolean().optional(),
  printBills: z.boolean().optional(),
  stationIds: z.array(z.string().min(1)).max(50).optional(),
  copies: z.number().int().min(1).max(5).optional(),
  autoPrintKot: z.boolean().optional(),
  autoPrintBill: z.boolean().optional(),
  drawerKick: z.boolean().optional(),
  isActive: z.boolean().optional(),
};

const connectionNeeds = (p: { connection?: PrinterConnection; host?: string | null; usbPath?: string | null }) =>
  !(p.connection === "NETWORK" && !p.host) && !(p.connection === "USB" && !p.usbPath);

export const CreatePrinterSchema = z
  .object(PrinterFields)
  .refine(connectionNeeds, { message: "Network printers need a host; USB printers need a device path" });
export type CreatePrinterInput = z.infer<typeof CreatePrinterSchema>;

export const UpdatePrinterSchema = z.object({ ...PrinterFields, name: PrinterFields.name.optional(), connection: PrinterConnectionEnum.optional() });
export type UpdatePrinterInput = z.infer<typeof UpdatePrinterSchema>;

// ---------- Outlet print settings (bill header/footer) ----------

export interface PrintSettingsDto {
  fssaiNumber: string | null;
  headerLines: string[];
  footerLines: string[];
  /** Print a scan-to-pay UPI QR on provisional (unpaid) bills. */
  upiQrOnBill: boolean;
}

export const UpdatePrintSettingsSchema = z.object({
  fssaiNumber: z.string().trim().regex(/^\d{14}$/, "FSSAI licence numbers are 14 digits").nullable().optional(),
  headerLines: z.array(z.string().max(64)).max(4).optional(),
  footerLines: z.array(z.string().max(64)).max(4).optional(),
  upiQrOnBill: z.boolean().optional(),
});
export type UpdatePrintSettingsInput = z.infer<typeof UpdatePrintSettingsSchema>;

// ---------- Print jobs ----------

export type PrintJobStatus = "QUEUED" | "PRINTING" | "PRINTED" | "FAILED" | "CANCELLED";

export interface PrintJobDto {
  id: string;
  printerId: string | null;
  printerName: string | null;
  kind: PrintJobKind;
  status: PrintJobStatus;
  payload: PrintPayload;
  copies: number;
  reprint: boolean;
  openDrawer: boolean;
  attempts: number;
  error: string | null;
  orderId: string | null;
  kotId: string | null;
  claimedBy: string | null;
  createdById: string | null;
  createdAt: string;
  printedAt: string | null;
}

/** A claimed job, with the printer config the claimant needs to deliver it. */
export interface ClaimedPrintJobDto extends PrintJobDto {
  printer: PrinterDto | null;
}

export const ClaimPrintJobsSchema = z.object({
  /** Free-form id of the claimant (edge device id, browser terminal id). */
  agentId: z.string().trim().min(1).max(80),
  /** Restrict to these printers. Omit for any printer matching `connections`. */
  printerIds: z.array(z.string().min(1)).max(50).optional(),
  connections: z.array(PrinterConnectionEnum).max(3).optional(),
  /** Only jobs this user created (a terminal printing its own punches). */
  mine: z.boolean().optional(),
  /** Only jobs nobody has picked up for this long (a fallback printer stepping in). */
  olderThanSeconds: z.number().int().min(1).max(3600).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type ClaimPrintJobsInput = z.infer<typeof ClaimPrintJobsSchema>;

export const CompletePrintJobSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(300).optional(),
  agentId: z.string().trim().min(1).max(80).optional(),
});
export type CompletePrintJobInput = z.infer<typeof CompletePrintJobSchema>;

export const PrintRequestSchema = z.object({
  /** Send to one printer; omit to use every matching active printer. */
  printerId: z.string().min(1).optional(),
});
export type PrintRequestInput = z.infer<typeof PrintRequestSchema>;

/** A settled order, as listed for reprinting. */
export interface RecentBillDto {
  orderId: string;
  billNumber: string | null;
  tableName: string | null;
  orderType: string;
  total: number;
  settledAt: string;
}
