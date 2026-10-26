import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

/** Seller/buyer address block (INV-01 SellerDtls / BuyerDtls). */
export interface EInvoiceParty {
  gstin: string;
  legalName: string;
  tradeName?: string | null;
  address1: string;
  address2?: string | null;
  location: string;
  pincode: number;
  stateCode: string;
  phone?: string | null;
  email?: string | null;
}

/** One ItemList line. Restaurant supplies are services (SAC 996331): IsServc = Y. */
export interface EInvoiceItem {
  serial: number;
  description: string;
  hsn: string;
  isService: boolean;
  quantity: number;
  unit: string;
  unitPrice: number;
  assessable: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface IrnRequest {
  sellerGstin: string;
  invoiceNumber: string;
  invoiceDate: string; // ISO
  total: number;
  taxableValue: number;
  // Full INV-01 detail. The mock needs none of it; a real IRP rejects requests without it.
  seller?: EInvoiceParty;
  buyer?: EInvoiceParty & { placeOfSupply: string };
  items?: EInvoiceItem[];
  cgst?: number;
  sgst?: number;
  igst?: number;
  roundOff?: number;
}
export interface IrnResult {
  irn: string;
  signedQr: string;
  ackNo: string;
  ackDate: string;
  signedInvoice?: string | null;
  ewbNo?: string | null;
  ewbValidTill?: string | null;
}
export interface CancelIrnResult {
  cancelDate: string;
}
export interface EwayBillByIrnRequest {
  sellerGstin: string;
  irn: string;
  distanceKm: number;
  transporterId?: string;
  transporterName?: string;
  vehicleNumber?: string;
  transportMode?: "1" | "2" | "3" | "4"; // road | rail | air | ship
}
export interface EwayBillResult {
  ewbNo: string;
  ewbDate: string;
  validTill: string | null;
}

/**
 * GSP/IRP seam. Real e-invoicing POSTs the INV-01 JSON to a GSP, which relays to
 * the IRP and returns the IRN + signed QR + ack. We never touch GSTN directly.
 */
export interface EInvoiceProvider {
  readonly name: string;
  readonly live: boolean;
  generateIrn(req: IrnRequest): Promise<IrnResult>;
  /** IRP cancel reason codes: 1 duplicate, 2 data-entry mistake, 3 order cancelled, 4 others. */
  cancelIrn(irn: string, reason: string, opts?: { sellerGstin: string; reasonCode?: "1" | "2" | "3" | "4" }): Promise<CancelIrnResult>;
  /** Taxpayer master lookup (buyer legal name/address for B2B invoices). */
  lookupGstin?(userGstin: string, gstin: string): Promise<Partial<EInvoiceParty> | null>;
  generateEwayBill?(req: EwayBillByIrnRequest): Promise<EwayBillResult>;
}

export const EINVOICE_PROVIDER = Symbol("EINVOICE_PROVIDER");

/** Default when no GSP credentials are configured. Nothing is reported to the IRP. */
@Injectable()
export class MockGspProvider implements EInvoiceProvider {
  readonly name = "mock-gsp";
  readonly live = false;

  async generateIrn(req: IrnRequest): Promise<IrnResult> {
    // The real IRN is a 64-char hash of gstin + docNo + docType + FY. We mirror
    // that shape deterministically so the same invoice always yields the same IRN.
    const irn = createHash("sha256")
      .update(`${req.sellerGstin}|${req.invoiceNumber}|INV|${req.invoiceDate.slice(0, 4)}`)
      .digest("hex");
    // Signed QR is a JWS in production; the mock encodes a compact summary.
    const signedQr = Buffer.from(
      JSON.stringify({
        SellerGstin: req.sellerGstin,
        DocNo: req.invoiceNumber,
        TotInvVal: req.total,
        Irn: irn,
      }),
    ).toString("base64");
    const ackNo = (112400000000000 + (parseInt(irn.slice(0, 8), 16) % 1000000000)).toString();
    return { irn, signedQr, ackNo, ackDate: new Date().toISOString() };
  }

  async cancelIrn(): Promise<CancelIrnResult> {
    return { cancelDate: new Date().toISOString() };
  }
}
