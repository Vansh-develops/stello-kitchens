import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

export interface IrnRequest {
  sellerGstin: string;
  invoiceNumber: string;
  invoiceDate: string; // ISO
  total: number;
  taxableValue: number;
}
export interface IrnResult {
  irn: string;
  signedQr: string;
  ackNo: string;
  ackDate: string;
}

/**
 * GSP/IRP seam. Real e-invoicing means POSTing the INV-01 JSON to a GSP, which
 * relays to the IRP and returns the IRN + signed QR + ack. We never touch GSTN
 * directly — this interface is where a live GSP client (e.g. via Tally/ClearTax)
 * plugs in.
 */
export interface EInvoiceProvider {
  readonly name: string;
  generateIrn(req: IrnRequest): Promise<IrnResult>;
  cancelIrn(irn: string, reason: string): Promise<void>;
}

export const EINVOICE_PROVIDER = Symbol("EINVOICE_PROVIDER");

@Injectable()
export class MockGspProvider implements EInvoiceProvider {
  readonly name = "mock-gsp";

  async generateIrn(req: IrnRequest): Promise<IrnResult> {
    // The real IRN is a 64-char hash of gstin + docNo + docType + FY. We mirror
    // that shape deterministically so the same invoice always yields the same IRN.
    const irn = createHash("sha256")
      .update(`${req.sellerGstin}|${req.invoiceNumber}|INV|${req.invoiceDate.slice(0, 4)}`)
      .digest("hex");
    // Signed QR is a base64 payload (JWS in production); we encode a compact summary.
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

  async cancelIrn(): Promise<void> {
    // Real: POST /cancel within the 24h window; store the cancellation ack.
  }
}
