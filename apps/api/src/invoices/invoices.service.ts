import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser, HsnSummaryRowDto, InvoiceDto, InvoiceRowDto } from "@petpooja/shared";
import { fromPaise, toPaise } from "@petpooja/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EINVOICE_PROVIDER, type EInvoiceProvider } from "./einvoice.provider";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const r2 = (n: number) => Math.round(n * 100) / 100;

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
    return orders.map((o) => {
      const inv = byOrder.get(o.id);
      const tax = N(o.taxAmount);
      return {
        orderId: o.id,
        invoiceNumber: o.billNumber ?? "",
        invoiceDate: o.createdAt.toISOString(),
        customerName: o.customerName,
        taxableValue: r2(N(o.subtotal) - N(o.discountAmount)),
        cgst: r2(tax / 2),
        sgst: r2(tax / 2),
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

    const hsnSummary = await this.buildHsnSummary(order);
    const tax = N(order.taxAmount);
    return {
      id: stored?.id ?? "",
      orderId,
      invoiceNumber: order.billNumber,
      invoiceDate: order.createdAt.toISOString(),
      customerName: order.customerName,
      sellerGstin: outlet.gstin,
      buyerGstin: stored?.buyerGstin ?? null,
      placeOfSupply: outlet.placeOfSupply,
      taxableValue: r2(N(order.subtotal) - N(order.discountAmount)),
      cgst: r2(tax / 2),
      sgst: r2(tax / 2),
      igst: 0,
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
  private async buildHsnSummary(order: {
    subtotal: Prisma.Decimal;
    discountAmount: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    items: { itemId: string; lineTotal: Prisma.Decimal; taxRate: Prisma.Decimal }[];
  }): Promise<HsnSummaryRowDto[]> {
    const itemIds = [...new Set(order.items.map((i) => i.itemId))];
    const items = await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, hsnCode: true } });
    const hsnByItem = new Map(items.map((i) => [i.id, i.hsnCode ?? "996331"]));

    // Allocate the order's taxable value and tax across HSN groups in integer
    // paise, so the rows are exact and never drift against the order total.
    const subtotalPaise = toPaise(N(order.subtotal));
    const taxablePaise = subtotalPaise - toPaise(N(order.discountAmount));

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
      const halfPaise = Math.round(taxPaise / 2);
      return { hsn: g.hsn, rate: g.rate, taxable: fromPaise(groupTaxablePaise), cgst: fromPaise(halfPaise), sgst: fromPaise(halfPaise) };
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
        cgst: detail.cgst,
        sgst: detail.sgst,
        total: detail.total,
        hsnSummary: detail.hsnSummary as unknown as Prisma.InputJsonValue,
        irn: res.irn,
        signedQr: res.signedQr,
        ackNo: res.ackNo,
        ackDate: new Date(res.ackDate),
        status: "GENERATED",
      },
      update: {
        buyerGstin: buyerGstin ?? undefined,
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
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fmtDate = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const amt = (n: number) => n.toFixed(2);

    const vouchers = orders
      .map((o) => {
        const taxable = N(o.subtotal) - N(o.discountAmount);
        const tax = N(o.taxAmount);
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
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-${amt(tax / 2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-${amt(tax / 2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
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
