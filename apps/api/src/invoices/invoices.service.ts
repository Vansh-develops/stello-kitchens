import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  CancelIrnInput,
  EInvoiceProfileDto,
  EInvoiceProfileInput,
  EwayBillByIrnInput,
  GenerateIrnInput,
  HsnSummaryRowDto,
  InvoiceDto,
  InvoiceRowDto,
} from "@stello/shared";
import { fromPaise, IRN_CANCEL_WINDOW_MS, toPaise } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EINVOICE_PROVIDER, type EInvoiceProvider, type IrnRequest } from "./einvoice.provider";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const r2 = (n: number) => Math.round(n * 100) / 100;

/** First two digits of a GSTIN are the state code (e.g. "29" = Karnataka). */
const stateOf = (gstin?: string | null) => (gstin && gstin.length >= 2 ? gstin.slice(0, 2) : null);

/**
 * Split a tax amount into CGST/SGST (intra-state) or IGST (inter-state). A supply
 * is inter-state when the buyer's GSTIN state differs from the outlet's place of
 * supply; then the full rate is IGST and CGST/SGST are zero. B2C sales (no buyer
 * GSTIN) are treated as intra-state at the point of supply.
 */
function splitTax(taxAmount: number, sellerState: string | null, buyerGstin?: string | null) {
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
        taxableValue: r2(N(o.subtotal) - N(o.discountAmount)),
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
      taxableValue: r2(N(order.subtotal) - N(order.discountAmount)),
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
      gspProvider: stored?.gspProvider ?? null,
      cancelledAt: stored?.cancelledAt?.toISOString() ?? null,
      cancelReason: stored?.cancelReason ?? null,
      ewbNo: stored?.ewbNo ?? null,
      ewbValidTill: stored?.ewbValidTill?.toISOString() ?? null,
    };
  }

  /** Group order lines by (HSN, rate) and allocate the order's taxable + tax across them. */
  private async buildHsnSummary(
    order: {
      subtotal: Prisma.Decimal;
      discountAmount: Prisma.Decimal;
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
      const taxable = fromPaise(groupTaxablePaise);
      // Inter-state: whole tax is IGST. Intra-state: split evenly into CGST + SGST.
      if (interState) return { hsn: g.hsn, rate: g.rate, taxable, cgst: 0, sgst: 0, igst: fromPaise(taxPaise) };
      const halfPaise = Math.round(taxPaise / 2);
      return { hsn: g.hsn, rate: g.rate, taxable, cgst: fromPaise(halfPaise), sgst: fromPaise(halfPaise), igst: 0 };
    });
  }

  async generateIrn(user: AuthUser, outletId: string, orderId: string, buyerGstin?: string, buyerOverride?: GenerateIrnInput["buyer"]) {
    this.assertOutlet(user, outletId);
    const detail = await this.detail(user, outletId, orderId);
    if (detail.irn && detail.status !== "CANCELLED") throw new BadRequestException("An IRN already exists for this invoice");
    if (detail.irn) throw new BadRequestException("This invoice number's IRN was cancelled; the IRP does not allow re-using it");
    if (!detail.sellerGstin) throw new BadRequestException("Outlet has no GSTIN configured");

    // A buyer GSTIN supplied now may make this an inter-state supply — detail() was
    // computed against the previously-stored buyer, so re-evaluate the split (and
    // re-cast the HSN rows) for the buyer actually being recorded.
    const effectiveBuyer = buyerGstin ?? detail.buyerGstin;
    const taxTotal = r2(detail.cgst + detail.sgst + detail.igst);
    const sellerState = detail.placeOfSupply ?? stateOf(detail.sellerGstin);
    const split = splitTax(taxTotal, sellerState, effectiveBuyer);
    const rows = detail.hsnSummary.map((row) => {
      const rowTax = r2(row.cgst + row.sgst + row.igst);
      return split.interState
        ? { ...row, cgst: 0, sgst: 0, igst: rowTax }
        : { ...row, cgst: r2(rowTax / 2), sgst: r2(rowTax / 2), igst: 0 };
    });
    const hsnSummary = rows as unknown as Prisma.InputJsonValue;

    // A live IRP needs the full INV-01: a registered buyer (e-invoices are B2B
    // only), the seller address and line items. The mock accepts the summary alone.
    let full: Partial<IrnRequest> = {};
    if (this.gsp.live) {
      if (!effectiveBuyer) throw new BadRequestException("E-invoices are for B2B sales — enter the buyer GSTIN");
      const profile = await this.prisma.eInvoiceProfile.findFirst({ where: { tenantId: user.tenantId, outletId } });
      if (!profile) throw new BadRequestException("Set up the outlet e-invoice seller details (legal name, address, pincode) first");
      const looked = this.gsp.lookupGstin ? await this.gsp.lookupGstin(detail.sellerGstin, effectiveBuyer) : null;
      const buyer = {
        gstin: effectiveBuyer,
        legalName: buyerOverride?.legalName ?? looked?.legalName ?? "",
        tradeName: looked?.tradeName ?? null,
        address1: buyerOverride?.address1 ?? looked?.address1 ?? "",
        location: buyerOverride?.location ?? looked?.location ?? "",
        pincode: buyerOverride?.pincode ?? looked?.pincode ?? 0,
        stateCode: looked?.stateCode ?? effectiveBuyer.slice(0, 2),
        placeOfSupply: sellerState ?? effectiveBuyer.slice(0, 2),
      };
      if (!buyer.legalName || !buyer.address1 || !buyer.location || !buyer.pincode) {
        throw new BadRequestException("Buyer address is incomplete — enter legal name, address, city and pincode");
      }
      const items = rows.map((row, i) => {
        const tax = r2(row.cgst + row.sgst + row.igst);
        return {
          serial: i + 1,
          description: `Restaurant service (SAC ${row.hsn}) @ ${row.rate}%`,
          hsn: row.hsn,
          isService: true,
          quantity: 1,
          unit: "OTH",
          unitPrice: row.taxable,
          assessable: row.taxable,
          gstRate: row.rate,
          cgst: row.cgst,
          sgst: row.sgst,
          igst: row.igst,
          total: r2(row.taxable + tax),
        };
      });
      const itemsTotal = r2(items.reduce((sum, it) => sum + it.total, 0));
      full = {
        seller: {
          gstin: detail.sellerGstin,
          legalName: profile.legalName,
          tradeName: profile.tradeName,
          address1: profile.address1,
          address2: profile.address2,
          location: profile.location,
          pincode: profile.pincode,
          stateCode: profile.stateCode,
          phone: profile.phone,
          email: profile.email,
        },
        buyer,
        items,
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        roundOff: r2(detail.total - itemsTotal),
      };
    }

    const res = await this.gsp.generateIrn({
      sellerGstin: detail.sellerGstin,
      invoiceNumber: detail.invoiceNumber,
      invoiceDate: detail.invoiceDate,
      total: detail.total,
      taxableValue: detail.taxableValue,
      ...full,
    });

    const ewb = { ewbNo: res.ewbNo ?? null, ewbValidTill: res.ewbValidTill ? new Date(res.ewbValidTill) : null };
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
        gspProvider: this.gsp.name,
        ...ewb,
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
        gspProvider: this.gsp.name,
        ...ewb,
      },
    });
    return this.detail(user, outletId, orderId);
  }

  /**
   * Cancel at the IRP (via the GSP) and only then mark the invoice cancelled.
   * The IRP allows cancellation within 24h of the ack; later corrections need a
   * credit note.
   */
  async cancelIrn(user: AuthUser, outletId: string, orderId: string, reason: string, reasonCode: CancelIrnInput["reasonCode"] = "4") {
    this.assertOutlet(user, outletId);
    const inv = await this.prisma.invoice.findFirst({ where: { orderId, tenantId: user.tenantId, outletId } });
    if (!inv?.irn) throw new BadRequestException("No IRN to cancel");
    if (inv.status === "CANCELLED") throw new BadRequestException("IRN already cancelled");
    if (inv.ackDate && Date.now() - inv.ackDate.getTime() > IRN_CANCEL_WINDOW_MS) {
      throw new BadRequestException("IRNs can only be cancelled within 24 hours of generation — issue a credit note instead");
    }
    const res = await this.gsp.cancelIrn(inv.irn, reason, { sellerGstin: inv.sellerGstin ?? "", reasonCode });
    await this.prisma.invoice.update({
      where: { orderId },
      data: { status: "CANCELLED", cancelledAt: new Date(res.cancelDate), cancelReason: reason },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: "IRN_CANCELLED",
        entity: "invoice",
        entityId: inv.id,
        data: { irn: inv.irn, reason, reasonCode },
      },
    });
    return this.detail(user, outletId, orderId);
  }

  /** E-way bill from an IRN (goods movements; restaurant services do not need one). */
  async generateEwayBill(user: AuthUser, outletId: string, orderId: string, input: EwayBillByIrnInput) {
    this.assertOutlet(user, outletId);
    const inv = await this.prisma.invoice.findFirst({ where: { orderId, tenantId: user.tenantId, outletId } });
    if (!inv?.irn || inv.status !== "GENERATED") throw new BadRequestException("Generate the IRN first");
    if (inv.ewbNo) throw new BadRequestException("An e-way bill already exists for this invoice");
    if (!this.gsp.generateEwayBill) throw new BadRequestException("The configured GSP does not support e-way bills");
    const res = await this.gsp.generateEwayBill({ sellerGstin: inv.sellerGstin ?? "", irn: inv.irn, ...input });
    await this.prisma.invoice.update({
      where: { orderId },
      data: { ewbNo: res.ewbNo, ewbValidTill: res.validTill ? new Date(res.validTill) : null },
    });
    return this.detail(user, outletId, orderId);
  }

  // ---------- Seller profile (INV-01 SellerDtls) ----------

  async getProfile(user: AuthUser, outletId: string): Promise<EInvoiceProfileDto> {
    this.assertOutlet(user, outletId);
    const [p, outlet] = await Promise.all([
      this.prisma.eInvoiceProfile.findFirst({ where: { tenantId: user.tenantId, outletId } }),
      this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } }),
    ]);
    const base = { gstin: outlet.gstin, provider: this.gsp.name, live: this.gsp.live };
    if (!p) {
      return { ...base, legalName: "", address1: "", location: "", pincode: 0, stateCode: outlet.placeOfSupply ?? stateOf(outlet.gstin) ?? "" };
    }
    return {
      ...base,
      legalName: p.legalName,
      tradeName: p.tradeName,
      address1: p.address1,
      address2: p.address2,
      location: p.location,
      pincode: p.pincode,
      stateCode: p.stateCode,
      phone: p.phone,
      email: p.email,
    };
  }

  async saveProfile(user: AuthUser, outletId: string, input: EInvoiceProfileInput) {
    this.assertOutlet(user, outletId);
    const data = {
      legalName: input.legalName,
      tradeName: input.tradeName ?? null,
      address1: input.address1,
      address2: input.address2 ?? null,
      location: input.location,
      pincode: input.pincode,
      stateCode: input.stateCode,
      phone: input.phone ?? null,
      email: input.email ?? null,
    };
    const existing = await this.prisma.eInvoiceProfile.findFirst({ where: { tenantId: user.tenantId, outletId } });
    if (existing) await this.prisma.eInvoiceProfile.update({ where: { id: existing.id }, data });
    else await this.prisma.eInvoiceProfile.create({ data: { tenantId: user.tenantId, outletId, ...data } });
    return this.getProfile(user, outletId);
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
