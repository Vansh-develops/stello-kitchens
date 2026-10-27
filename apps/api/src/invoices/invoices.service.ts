import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser, HsnSummaryRowDto, InvoiceDto, InvoiceRowDto } from "@stello/shared";
import { fromPaise, toPaise } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EINVOICE_PROVIDER, type EInvoiceProvider } from "./einvoice.provider";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Taxable value of a bill: food after discount, plus a taxable service charge. */
const taxableOf = (o: { subtotal: Prisma.Decimal; discountAmount: Prisma.Decimal; serviceChargeAmount: Prisma.Decimal; serviceChargeTaxable: boolean }) =>
  r2(N(o.subtotal) - N(o.discountAmount) + (o.serviceChargeTaxable ? N(o.serviceChargeAmount) : 0));

/** First two digits of a GSTIN are the state code (e.g. "29" = Karnataka). */
export const stateOf = (gstin?: string | null) => (gstin && gstin.length >= 2 ? gstin.slice(0, 2) : null);

/**
 * Split a tax amount into CGST/SGST (intra-state) or IGST (inter-state). A supply
 * is inter-state when the buyer's GSTIN state differs from the outlet's place of
 * supply; then the full rate is IGST and CGST/SGST are zero. B2C sales (no buyer
 * GSTIN) are treated as intra-state at the point of supply.
 */
export function splitTax(taxAmount: number, sellerState: string | null, buyerGstin?: string | null) {
  const buyerState = stateOf(buyerGstin);
  const interState = !!buyerState && !!sellerState && buyerState !== sellerState;
  if (interState) return { cgst: 0, sgst: 0, igst: r2(taxAmount), interState };
  const taxPaise = toPaise(taxAmount);
  const cgstPaise = Math.floor(taxPaise / 2);
  return { cgst: fromPaise(cgstPaise), sgst: fromPaise(taxPaise - cgstPaise), igst: 0, interState };
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EINVOICE_PROVIDER) private readonly gsp: EInvoiceProvider,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  private range(from: string, to: string) {
    return { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59.999`) };
  }

  async list(user: AuthUser, outletId: string, from: string, to: string): Promise<InvoiceRowDto[]> {
    this.assertOutlet(user, outletId);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "SETTLED", createdAt: this.range(from, to) },
      orderBy: { createdAt: "desc" },
    });
    const invoices = await this.prisma.invoice.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
    });
    const byOrder = new Map(invoices.map((i) => [i.orderId, i]));
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    const sellerState = outlet.placeOfSupply ?? stateOf(outlet.gstin);
    return orders.map((o) => {
      const inv = byOrder.get(o.id);
      const split = splitTax(N(o.taxAmount), sellerState, inv?.buyerGstin);
      return {
        orderId: o.id,
        invoiceNumber: o.billNumber ?? "",
        invoiceDate: o.createdAt.toISOString(),
        customerName: o.customerName,
        taxableValue: taxableOf(o),
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        total: N(o.total),
        status: (inv?.status as InvoiceRowDto["status"]) ?? "PENDING",
        hasIrn: !!inv?.irn,
      };
    });
  }

  async detail(user: AuthUser, outletId: string, orderId: string): Promise<InvoiceDto> {
    this.assertOutlet(user, outletId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, outletId, tenantId: user.tenantId },
      include: { items: true },
    });
    if (!order || order.status !== "SETTLED") throw new BadRequestException("Only settled orders have invoices");
    // A tax invoice must carry the authoritative outlet bill number — never a
    // truncated order id. Settled orders always have one (assigned at settle, or
    // at sync for offline sales).
    if (!order.billNumber) throw new BadRequestException("Settled order is missing its authoritative bill number");
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    const stored = await this.prisma.invoice.findUnique({ where: { orderId } });

    const tax = N(order.taxAmount);
    const sellerState = outlet.placeOfSupply ?? stateOf(outlet.gstin);
    const split = splitTax(tax, sellerState, stored?.buyerGstin);
    const hsnSummary = await this.buildHsnSummary(order, split.interState);
    return {
      id: stored?.id ?? "",
      orderId,
      invoiceNumber: order.billNumber,
      invoiceDate: order.createdAt.toISOString(),
      customerName: order.customerName,
      sellerGstin: outlet.gstin,
      buyerGstin: stored?.buyerGstin ?? null,
      placeOfSupply: outlet.placeOfSupply,
      taxableValue: taxableOf(order),
      cgst: split.cgst,
      sgst: split.sgst,
      igst: split.igst,
      total: N(order.total),
      hsnSummary,
      irn: stored?.irn ?? null,
      signedQr: stored?.signedQr ?? null,
      ackNo: stored?.ackNo ?? null,
      ackDate: stored?.ackDate?.toISOString() ?? null,
      status: (stored?.status as InvoiceDto["status"]) ?? "PENDING",
    };
  }

  /** Group order lines by (HSN, rate) and allocate the order's taxable + tax across them. */
  private async buildHsnSummary(
    order: {
      subtotal: Prisma.Decimal;
      discountAmount: Prisma.Decimal;
      serviceChargeAmount: Prisma.Decimal;
      serviceChargeTaxable: boolean;
      taxAmount: Prisma.Decimal;
      items: { itemId: string; lineTotal: Prisma.Decimal; taxRate: Prisma.Decimal }[];
    },
    interState: boolean,
  ): Promise<HsnSummaryRowDto[]> {
    const itemIds = [...new Set(order.items.map((i) => i.itemId))];
    const items = await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, hsnCode: true } });
    const hsnByItem = new Map(items.map((i) => [i.id, i.hsnCode ?? "996331"]));

    // Allocate the order's taxable value and tax across HSN groups in integer
    // paise, so the rows are exact and never drift against the order total.
    const subtotalPaise = toPaise(N(order.subtotal));
    const taxablePaise = toPaise(taxableOf(order));

    const groups = new Map<string, { hsn: string; rate: number; subtotalPaise: number }>();
    for (const line of order.items) {
      const hsn = hsnByItem.get(line.itemId) ?? "996331";
      const rate = N(line.taxRate);
      const key = `${hsn}@${rate}`;
      const g = groups.get(key) ?? { hsn, rate, subtotalPaise: 0 };
      g.subtotalPaise += toPaise(N(line.lineTotal)); // spread the discount proportionally below
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => {
      const groupTaxablePaise = subtotalPaise > 0 ? Math.round((g.subtotalPaise * taxablePaise) / subtotalPaise) : 0;
      const taxPaise = Math.round((groupTaxablePaise * g.rate) / 100);
      const taxable = fromPaise(groupTaxablePaise);
      // Inter-state: whole tax is IGST. Intra-state: split evenly into CGST + SGST.
      if (interState) return { hsn: g.hsn, rate: g.rate, taxable, cgst: 0, sgst: 0, igst: fromPaise(taxPaise) };
      const halfPaise = Math.round(taxPaise / 2);
      return { hsn: g.hsn, rate: g.rate, taxable, cgst: fromPaise(halfPaise), sgst: fromPaise(halfPaise), igst: 0 };
    });
  }

  async generateIrn(user: AuthUser, outletId: string, orderId: string, buyerGstin?: string) {
    this.assertOutlet(user, outletId);
    const detail = await this.detail(user, outletId, orderId);
    if (detail.irn) throw new BadRequestException("An IRN already exists for this invoice");
    if (!detail.sellerGstin) throw new BadRequestException("Outlet has no GSTIN configured");

    const res = await this.gsp.generateIrn({
      sellerGstin: detail.sellerGstin,
      invoiceNumber: detail.invoiceNumber,
      invoiceDate: detail.invoiceDate,
      total: detail.total,
      taxableValue: detail.taxableValue,
    });

    // A buyer GSTIN supplied now may make this an inter-state supply — detail() was
    // computed against the previously-stored buyer, so re-evaluate the split (and
    // re-cast the HSN rows) for the buyer actually being recorded.
    const effectiveBuyer = buyerGstin ?? detail.buyerGstin;
    const taxTotal = r2(detail.cgst + detail.sgst + detail.igst);
    const sellerState = detail.placeOfSupply ?? stateOf(detail.sellerGstin);
    const split = splitTax(taxTotal, sellerState, effectiveBuyer);
    const hsnSummary = detail.hsnSummary.map((row) => {
      const rowTax = r2(row.cgst + row.sgst + row.igst);
      return split.interState
        ? { ...row, cgst: 0, sgst: 0, igst: rowTax }
        : { ...row, cgst: r2(rowTax / 2), sgst: r2(rowTax / 2), igst: 0 };
    }) as unknown as Prisma.InputJsonValue;

    await this.prisma.invoice.upsert({
      where: { orderId },
      create: {
        tenantId: user.tenantId,
        outletId,
        orderId,
        invoiceNumber: detail.invoiceNumber,
        invoiceDate: new Date(detail.invoiceDate),
        sellerGstin: detail.sellerGstin,
        buyerGstin: buyerGstin ?? null,
        placeOfSupply: detail.placeOfSupply,
        taxableValue: detail.taxableValue,
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        total: detail.total,
        hsnSummary,
        irn: res.irn,
        signedQr: res.signedQr,
        ackNo: res.ackNo,
        ackDate: new Date(res.ackDate),
        status: "GENERATED",
      },
      update: {
        buyerGstin: buyerGstin ?? undefined,
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        hsnSummary,
        irn: res.irn,
        signedQr: res.signedQr,
        ackNo: res.ackNo,
        ackDate: new Date(res.ackDate),
        status: "GENERATED",
      },
    });
    return this.detail(user, outletId, orderId);
  }

  async cancelIrn(user: AuthUser, outletId: string, orderId: string, reason: string) {
    this.assertOutlet(user, outletId);
    const inv = await this.prisma.invoice.findUnique({ where: { orderId } });
    if (!inv?.irn) throw new BadRequestException("No IRN to cancel");
    await this.gsp.cancelIrn(inv.irn, reason);
    await this.prisma.invoice.update({ where: { orderId }, data: { status: "CANCELLED" } });
    return this.detail(user, outletId, orderId);
  }

  /** Tally-importable XML of sales vouchers, ledger-mapped (Sales / Output CGST+SGST). */
  async tallyExport(user: AuthUser, outletId: string, from: string, to: string): Promise<string> {
    this.assertOutlet(user, outletId);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "SETTLED", createdAt: this.range(from, to) },
      include: { payments: true },
      orderBy: { createdAt: "asc" },
    });
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    const sellerState = outlet.placeOfSupply ?? stateOf(outlet.gstin);
    const buyers = await this.prisma.invoice.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, select: { orderId: true, buyerGstin: true } });
    const buyerOf = new Map(buyers.map((b) => [b.orderId, b.buyerGstin]));
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fmtDate = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const amt = (n: number) => n.toFixed(2);

    const vouchers = orders
      .map((o) => {
        const taxable = N(o.subtotal) - N(o.discountAmount);
        const gst = splitTax(N(o.taxAmount), sellerState, buyerOf.get(o.id));
        const sc = N(o.serviceChargeAmount);
        const roundOff = N(o.roundOff);
        const credit = (ledger: string, n: number) =>
          `
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><ISDEEMEDPOSITIVE>${n >= 0 ? "No" : "Yes"}</ISDEEMEDPOSITIVE><AMOUNT>${amt(-n)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
        const total = N(o.total);
        // Party ledger from the dominant payment mode.
        const dominant = [...o.payments].sort((a, b) => N(b.amount) - N(a.amount))[0]?.mode ?? "CASH";
        const party = dominant === "CASH" ? "Cash" : `${dominant} Receivable`;
        return `   <TALLYMESSAGE>
    <VOUCHER VCHTYPE="Sales" ACTION="Create">
     <DATE>${fmtDate(o.createdAt)}</DATE>
     <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
     <VOUCHERNUMBER>${esc(o.billNumber ?? "")}</VOUCHERNUMBER>
     <PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(party)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${amt(total)}</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-${amt(taxable)}</AMOUNT></ALLLEDGERENTRIES.LIST>
${sc ? credit("Service Charge", sc) : ""}${gst.igst ? credit("Output IGST", gst.igst) : credit("Output CGST", gst.cgst) + credit("Output SGST", gst.sgst)}${roundOff ? credit("Round Off", roundOff) : ""}
    </VOUCHER>
   </TALLYMESSAGE>`;
      })
      .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
   <REQUESTDATA>
${vouchers}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
  }
}
