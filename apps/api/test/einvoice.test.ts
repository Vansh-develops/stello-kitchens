import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrdersService } from "../src/orders/orders.service";
import { InvoicesService } from "../src/invoices/invoices.service";
import { MockGspProvider } from "../src/invoices/einvoice.provider";
import { MastersIndiaGspProvider, irpDate } from "../src/invoices/masters-india.provider";
import { capture, mockHttp, providerFixture, realtimeStub, type Captured } from "./providers-fixture";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());

const MI = "https://sandb-api.mastersindia.co";
const BUYER = "27AAPFU0939F1ZV"; // Maharashtra → inter-state from Karnataka (29)
const ok = (message: unknown) => ({ results: { message, errorMessage: "", InfoDtls: "", status: "Success", code: 200 } });
const fail = (errorMessage: string) => ({ results: { message: "", errorMessage, InfoDtls: "", status: "Failed", code: 204 } });
const IRN = "a".repeat(64);
// IRP timestamps are IST "YYYY-MM-DD HH:mm:ss"; keep the ack recent so the 24h cancel window is open.
const istNow = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
const irnMessage = { Irn: IRN, AckNo: 112410000000001, AckDt: istNow, SignedQRCode: "eyJhbGciOi.qr", SignedInvoice: "eyJhbGciOi.inv", Status: "ACT" };

let http: ReturnType<typeof mockHttp>;
beforeEach(() => {
  http = mockHttp();
});
afterEach(() => http.restore());

async function settledInvoice(gsp: MastersIndiaGspProvider | MockGspProvider) {
  const f = await providerFixture(prisma);
  const rt = realtimeStub();
  const orders = new OrdersService(prisma, rt.gateway as any, { verifyAndConsume: vi.fn() } as any);
  const order = await orders.create(f.user, { outletId: f.outlet.id, orderType: "TAKEAWAY", items: [{ itemId: f.item.id, quantity: 2, addonIds: [] }], combos: [] });
  await orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 210 }] });
  return { ...f, order, invoices: new InvoicesService(prisma, gsp) };
}

describe("Masters India GSP adapter", () => {
  it("logs in once, caches the JWT token and posts a B2B service INV payload", async () => {
    const pool = http.agent.get(MI);
    const logins: Captured[] = [];
    const gens: Captured[] = [];
    pool.intercept({ path: "/api/v1/token-auth/", method: "POST" }).reply(capture(logins, { token: "tok-1" }));
    pool.intercept({ path: "/api/v1/einvoice/", method: "POST" }).reply(capture(gens, ok(irnMessage))).times(2);
    const gsp = new MastersIndiaGspProvider({ baseUrl: MI, username: "u", password: "p" });
    const req = {
      sellerGstin: "29AABCU9603R1ZM", invoiceNumber: "B-12", invoiceDate: "2026-10-26T06:00:00.000Z", total: 210, taxableValue: 200,
      seller: { gstin: "29AABCU9603R1ZM", legalName: "Stello Foods Pvt Ltd", address1: "12 MG Road", location: "Bengaluru", pincode: 560001, stateCode: "29" },
      buyer: { gstin: BUYER, legalName: "Acme LLP", address1: "1 Marine Dr", location: "Mumbai", pincode: 400001, stateCode: "27", placeOfSupply: "29" },
      items: [{ serial: 1, description: "Restaurant service", hsn: "996331", isService: true, quantity: 1, unit: "OTH", unitPrice: 200, assessable: 200, gstRate: 5, cgst: 0, sgst: 0, igst: 10, total: 210 }],
      cgst: 0, sgst: 0, igst: 10, roundOff: 0,
    };
    const res = await gsp.generateIrn(req);
    await gsp.generateIrn(req);
    expect(logins).toHaveLength(1);
    expect(logins[0].body).toEqual({ username: "u", password: "p" });
    expect(gens[0].headers.authorization).toBe("JWT tok-1");
    expect(gens[0].body).toMatchObject({
      user_gstin: "29AABCU9603R1ZM",
      transaction_details: { supply_type: "B2B" },
      document_details: { document_type: "INV", document_number: "B-12", document_date: "26/10/2026" },
      buyer_details: { gstin: BUYER, place_of_supply: "29", state_code: "27" },
      value_details: { total_assessable_value: 200, total_igst_value: 10, total_invoice_value: 210 },
      item_list: [{ is_service: "Y", hsn_code: "996331", gst_rate: 5, igst_amount: 10 }],
    });
    expect(res).toMatchObject({ irn: IRN, ackNo: "112410000000001", signedQr: "eyJhbGciOi.qr" });
    expect(Math.abs(new Date(res.ackDate).getTime() - Date.now())).toBeLessThan(5_000); // IST → UTC
  });

  it("re-authenticates once on a 401 and recovers an existing IRN on duplicate (2150)", async () => {
    const pool = http.agent.get(MI);
    const logins: Captured[] = [];
    pool.intercept({ path: "/api/v1/token-auth/", method: "POST" }).reply(capture(logins, { token: "old" }));
    pool.intercept({ path: "/api/v1/einvoice/", method: "POST" }).reply(401, {});
    pool.intercept({ path: "/api/v1/token-auth/", method: "POST" }).reply(capture(logins, { token: "new" }));
    pool.intercept({ path: "/api/v1/einvoice/", method: "POST" }).reply(200, fail("2150: Duplicate IRN"));
    const lookups: Captured[] = [];
    pool.intercept({ path: (p) => p.startsWith("/api/v1/get-einvoice-bydoc/"), method: "GET" }).reply(capture(lookups, ok(irnMessage)));
    const gsp = new MastersIndiaGspProvider({ baseUrl: MI, username: "u", password: "p" });
    const res = await gsp.generateIrn({
      sellerGstin: "29AABCU9603R1ZM", invoiceNumber: "B-3", invoiceDate: "2026-10-26T06:00:00.000Z", total: 105, taxableValue: 100,
      seller: { gstin: "29AABCU9603R1ZM", legalName: "S", address1: "A", location: "L", pincode: 560001, stateCode: "29" },
      buyer: { gstin: BUYER, legalName: "B", address1: "A", location: "L", pincode: 400001, stateCode: "27", placeOfSupply: "29" },
      items: [{ serial: 1, description: "x", hsn: "996331", isService: true, quantity: 1, unit: "OTH", unitPrice: 100, assessable: 100, gstRate: 5, cgst: 0, sgst: 0, igst: 5, total: 105 }],
    });
    expect(logins).toHaveLength(2);
    expect(res.irn).toBe(IRN);
    expect(Object.fromEntries(new URL(lookups[0].path, MI).searchParams)).toMatchObject({ document_number: "B-3", document_date: "26/10/2026" });
  });

  it("formats IRP document dates in IST", () => {
    expect(irpDate("2026-10-25T20:00:00.000Z")).toBe("26/10/2026"); // 01:30 IST next day
  });
});

describe("InvoicesService with a live GSP", () => {
  it("requires seller details and a buyer GSTIN, generates from the invoice model, then cancels at the IRP", async () => {
    const gsp = new MastersIndiaGspProvider({ baseUrl: MI, username: "u", password: "p" });
    const s = await settledInvoice(gsp);
    await expect(s.invoices.generateIrn(s.user, s.outlet.id, s.order.id)).rejects.toThrow("B2B");
    await expect(s.invoices.generateIrn(s.user, s.outlet.id, s.order.id, BUYER)).rejects.toThrow("seller details");
    await s.invoices.saveProfile(s.user, s.outlet.id, { legalName: "Stello Foods Pvt Ltd", address1: "12 MG Road", location: "Bengaluru", pincode: 560001, stateCode: "29" });

    const pool = http.agent.get(MI);
    pool.intercept({ path: "/api/v1/token-auth/", method: "POST" }).reply(200, { token: "tok" });
    pool.intercept({ path: (p) => p.startsWith("/api/v1/get-gstin-details/"), method: "GET" })
      .reply(200, ok({ Gstin: BUYER, LegalName: "Acme LLP", AddrBno: "1", AddrSt: "Marine Drive", AddrLoc: "Mumbai", StateCode: 27, AddrPncd: 400001, Status: "ACT" }));
    const gens: Captured[] = [];
    pool.intercept({ path: "/api/v1/einvoice/", method: "POST" }).reply(capture(gens, ok(irnMessage)));

    const inv = await s.invoices.generateIrn(s.user, s.outlet.id, s.order.id, BUYER);
    expect(inv).toMatchObject({ status: "GENERATED", irn: IRN, igst: 10, cgst: 0, gspProvider: "masters-india" });
    expect(gens[0].body).toMatchObject({
      seller_details: { legal_name: "Stello Foods Pvt Ltd", pincode: 560001 },
      buyer_details: { legal_name: "Acme LLP", address1: "1, Marine Drive", pincode: 400001, state_code: "27" },
      value_details: { total_assessable_value: 200, total_igst_value: 10, total_invoice_value: 210, round_off_amount: 0 },
    });

    const cancels: Captured[] = [];
    pool.intercept({ path: "/api/v1/cancel-einvoice/", method: "POST" }).reply(capture(cancels, ok({ Irn: IRN, CancelDate: "2026-10-26 14:00:00" })));
    const cancelled = await s.invoices.cancelIrn(s.user, s.outlet.id, s.order.id, "Wrong buyer", "2");
    expect(cancels[0].body).toEqual({ user_gstin: "29AABCU9603R1ZM", irn: IRN, cancel_reason: "2", cancel_remarks: "Wrong buyer", ewaybill_cancel: "" });
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelReason: "Wrong buyer" });
    await expect(s.invoices.cancelIrn(s.user, s.outlet.id, s.order.id, "again")).rejects.toThrow("already cancelled");
  });

  it("refuses cancellation after the 24h IRP window without calling the GSP", async () => {
    const s = await settledInvoice(new MastersIndiaGspProvider({ baseUrl: MI, username: "u", password: "p" }));
    await prisma.invoice.create({
      data: {
        tenantId: s.tenant.id, outletId: s.outlet.id, orderId: s.order.id, invoiceNumber: "B-1", sellerGstin: "29AABCU9603R1ZM",
        taxableValue: 200, cgst: 5, sgst: 5, total: 210, irn: IRN, status: "GENERATED", ackDate: new Date(Date.now() - 25 * 3600_000),
      },
    });
    await expect(s.invoices.cancelIrn(s.user, s.outlet.id, s.order.id, "late")).rejects.toThrow("24 hours");
  });

  it("keeps the mock GSP working for B2C demo invoices", async () => {
    const s = await settledInvoice(new MockGspProvider());
    const inv = await s.invoices.generateIrn(s.user, s.outlet.id, s.order.id);
    expect(inv.irn).toHaveLength(64);
    const cancelled = await s.invoices.cancelIrn(s.user, s.outlet.id, s.order.id, "test");
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledAt).toBeTruthy();
  });
});
