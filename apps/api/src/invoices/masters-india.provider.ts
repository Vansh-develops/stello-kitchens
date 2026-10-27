import { BadRequestException, BadGatewayException } from "@nestjs/common";
import { httpJson, ProviderHttpError } from "../integrations/http";
import type {
  CancelIrnResult,
  EInvoiceParty,
  EInvoiceProvider,
  EwayBillByIrnRequest,
  EwayBillResult,
  IrnRequest,
  IrnResult,
} from "./einvoice.provider";

export interface MastersIndiaConfig {
  baseUrl: string; // https://sandb-api.mastersindia.co (sandbox) | https://router.mastersindia.co (production)
  username: string;
  password: string;
}

export function mastersIndiaConfigFromEnv(env = process.env): MastersIndiaConfig | null {
  if (!env.MASTERS_INDIA_USERNAME || !env.MASTERS_INDIA_PASSWORD) return null;
  return {
    baseUrl: env.MASTERS_INDIA_BASE_URL ?? "https://sandb-api.mastersindia.co",
    username: env.MASTERS_INDIA_USERNAME,
    password: env.MASTERS_INDIA_PASSWORD,
  };
}

/** Masters India wraps every IRP answer as { results: { message, errorMessage, status, code } }. */
interface MiEnvelope<T> {
  results?: { message?: T | string; errorMessage?: string; status?: string; code?: number };
}
interface MiIrn {
  Irn: string;
  AckNo: number | string;
  AckDt: string;
  SignedQRCode: string;
  SignedInvoice?: string;
  EwbNo?: number | string | null;
  EwbValidTill?: string | null;
  Status?: string;
}

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // tokens live 24h; refresh an hour early
const r2 = (n: number) => Math.round(n * 100) / 100;

/** "2026-10-26T…" → "26/10/2026" (IRP DocDtls.Dt format, IST calendar day). */
export function irpDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
/** IRP "2026-10-26 13:20:56" (IST) → ISO. */
function fromIrpTimestamp(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}+05:30`).toISOString();
}

/**
 * Masters India e-invoicing GSP (REST, docs.mastersindia.co/einvoicing).
 *  - POST /api/v1/token-auth/ {username,password} → { token }, sent as `Authorization: JWT <token>`;
 *    cached for 23h and refreshed once on a 401.
 *  - POST /api/v1/einvoice/          generate IRN (+ signed QR / signed invoice)
 *  - GET  /api/v1/get-einvoice-bydoc/ recovery when a generate times out or the IRP
 *    reports a duplicate (2150) — the IRN for this document already exists.
 *  - POST /api/v1/cancel-einvoice/    cancel within 24h of generation
 *  - GET  /api/v1/get-gstin-details/  buyer master lookup
 *  - POST /api/v1/gen-ewb-by-irn/     e-way bill from an IRN (goods movements only)
 */
export class MastersIndiaGspProvider implements EInvoiceProvider {
  readonly name = "masters-india";
  readonly live = true;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(private readonly cfg: MastersIndiaConfig) {}

  private async authToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    // Collapse concurrent refreshes into one login.
    this.tokenPromise ??= (async () => {
      try {
        const { body } = await httpJson<{ token?: string; error?: string }>("masters-india", `${this.cfg.baseUrl}/api/v1/token-auth/`, {
          method: "POST",
          body: { username: this.cfg.username, password: this.cfg.password },
        });
        if (!body?.token) throw new ProviderHttpError("masters-india", 401, body?.error ?? "login failed");
        this.token = { value: body.token, expiresAt: Date.now() + TOKEN_TTL_MS };
        return body.token;
      } finally {
        this.tokenPromise = null;
      }
    })();
    return this.tokenPromise;
  }

  private async call<T>(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
    const send = async (token: string) =>
      httpJson<MiEnvelope<T>>("masters-india", `${this.cfg.baseUrl}${path}`, {
        method,
        headers: { Authorization: `JWT ${token}` },
        body: opts.body,
        query: opts.query,
        timeoutMs: 30_000,
      });
    let res;
    try {
      res = await send(await this.authToken());
    } catch (e) {
      if (!(e instanceof ProviderHttpError && e.status === 401)) throw e;
      res = await send(await this.authToken(true));
    }
    const r = res.body?.results;
    if (!r || r.status !== "Success" || typeof r.message !== "object" || !r.message) {
      throw new ProviderHttpError("masters-india", 422, r?.errorMessage || "IRP rejected the request", res.body);
    }
    return r.message as T;
  }

  async generateIrn(req: IrnRequest): Promise<IrnResult> {
    if (!req.seller || !req.buyer || !req.items?.length) {
      throw new BadRequestException("E-invoicing needs seller details, a registered buyer (GSTIN) and line items");
    }
    const party = (p: EInvoiceParty) => ({
      gstin: p.gstin,
      legal_name: p.legalName,
      trade_name: p.tradeName ?? p.legalName,
      address1: p.address1,
      address2: p.address2 ?? "",
      location: p.location,
      pincode: p.pincode,
      state_code: p.stateCode,
      phone_number: p.phone ?? "",
      email: p.email ?? "",
    });
    const payload = {
      user_gstin: req.sellerGstin,
      data_source: "erp",
      transaction_details: { supply_type: "B2B", charge_type: "N", igst_on_intra: "N", ecommerce_gstin: "" },
      document_details: { document_type: "INV", document_number: req.invoiceNumber, document_date: irpDate(req.invoiceDate) },
      seller_details: party(req.seller),
      buyer_details: { ...party(req.buyer), place_of_supply: req.buyer.placeOfSupply },
      value_details: {
        total_assessable_value: r2(req.taxableValue),
        total_cgst_value: r2(req.cgst ?? 0),
        total_sgst_value: r2(req.sgst ?? 0),
        total_igst_value: r2(req.igst ?? 0),
        total_cess_value: 0,
        total_cess_value_of_state: 0,
        total_discount: 0,
        total_other_charge: 0,
        total_invoice_value: r2(req.total),
        round_off_amount: r2(req.roundOff ?? 0),
      },
      item_list: req.items.map((i) => ({
        item_serial_number: String(i.serial),
        product_description: i.description.slice(0, 300),
        is_service: i.isService ? "Y" : "N",
        hsn_code: i.hsn,
        quantity: i.quantity,
        unit: i.unit,
        unit_price: r2(i.unitPrice),
        total_amount: r2(i.assessable),
        discount: 0,
        other_charge: 0,
        assessable_value: r2(i.assessable),
        gst_rate: i.gstRate,
        cgst_amount: r2(i.cgst),
        sgst_amount: r2(i.sgst),
        igst_amount: r2(i.igst),
        cess_rate: 0,
        cess_amount: 0,
        total_item_value: r2(i.total),
      })),
    };
    try {
      return this.toResult(await this.call<MiIrn>("POST", "/api/v1/einvoice/", { body: payload }));
    } catch (e) {
      // A timeout (we can't know if the IRP registered it) or "2150 duplicate IRN"
      // both mean: ask for the IRN of this document instead of failing.
      const dup = e instanceof ProviderHttpError && /\b2150\b/.test(e.message);
      if (dup || (e instanceof ProviderHttpError && e.uncertain)) {
        const existing = await this.byDocument(req).catch(() => null);
        if (existing) return existing;
      }
      if (e instanceof ProviderHttpError && !e.uncertain) throw new BadRequestException(e.message.replace(/^masters-india: /, ""));
      throw new BadGatewayException("The GSP did not respond — retry; a duplicate will be recovered automatically");
    }
  }

  private async byDocument(req: IrnRequest): Promise<IrnResult> {
    const m = await this.call<MiIrn>("GET", "/api/v1/get-einvoice-bydoc/", {
      query: { user_gstin: req.sellerGstin, document_type: "INV", document_number: req.invoiceNumber, document_date: irpDate(req.invoiceDate) },
    });
    return this.toResult(m);
  }

  private toResult(m: MiIrn): IrnResult {
    return {
      irn: m.Irn,
      signedQr: m.SignedQRCode,
      signedInvoice: m.SignedInvoice ?? null,
      ackNo: String(m.AckNo),
      ackDate: fromIrpTimestamp(m.AckDt) ?? new Date().toISOString(),
      ewbNo: m.EwbNo ? String(m.EwbNo) : null,
      ewbValidTill: fromIrpTimestamp(m.EwbValidTill ?? null),
    };
  }

  async cancelIrn(irn: string, reason: string, opts?: { sellerGstin: string; reasonCode?: "1" | "2" | "3" | "4" }): Promise<CancelIrnResult> {
    if (!opts?.sellerGstin) throw new BadRequestException("Seller GSTIN is required to cancel an IRN");
    try {
      const m = await this.call<{ Irn: string; CancelDate: string }>("POST", "/api/v1/cancel-einvoice/", {
        body: { user_gstin: opts.sellerGstin, irn, cancel_reason: opts.reasonCode ?? "4", cancel_remarks: reason.slice(0, 100), ewaybill_cancel: "" },
      });
      return { cancelDate: fromIrpTimestamp(m.CancelDate) ?? new Date().toISOString() };
    } catch (e) {
      if (e instanceof ProviderHttpError && !e.uncertain) throw new BadRequestException(e.message.replace(/^masters-india: /, ""));
      throw new BadGatewayException("The GSP did not respond — the IRN is not cancelled yet; retry");
    }
  }

  async lookupGstin(userGstin: string, gstin: string): Promise<Partial<EInvoiceParty> | null> {
    const m = await this.call<{
      Gstin: string;
      LegalName?: string | null;
      TradeName?: string | null;
      AddrBno?: string | null;
      AddrBnm?: string | null;
      AddrFlno?: string | null;
      AddrSt?: string | null;
      AddrLoc?: string | null;
      StateCode?: number | string | null;
      AddrPncd?: number | null;
      Status?: string;
    }>("GET", "/api/v1/get-gstin-details/", { query: { user_gstin: userGstin, gstin } });
    if (m.Status && m.Status !== "ACT") throw new BadRequestException(`Buyer GSTIN ${gstin} is not active`);
    const address1 = [m.AddrBno, m.AddrFlno, m.AddrBnm, m.AddrSt].filter(Boolean).join(", ");
    return {
      gstin: m.Gstin,
      legalName: m.LegalName ?? undefined,
      tradeName: m.TradeName ?? undefined,
      address1: address1 || undefined,
      location: m.AddrLoc ?? undefined,
      pincode: m.AddrPncd ?? undefined,
      stateCode: m.StateCode != null ? String(m.StateCode).padStart(2, "0") : undefined,
    };
  }

  async generateEwayBill(req: EwayBillByIrnRequest): Promise<EwayBillResult> {
    const m = await this.call<{ EwbNo: number | string; EwbDt: string; EwbValidTill?: string }>("POST", "/api/v1/gen-ewb-by-irn/", {
      body: {
        user_gstin: req.sellerGstin,
        irn: req.irn,
        transporter_id: req.transporterId ?? "",
        transporter_name: req.transporterName ?? "",
        transportation_mode: req.transportMode ?? "1",
        distance: req.distanceKm,
        vehicle_number: req.vehicleNumber ?? "",
        vehicle_type: "R",
        data_source: "erp",
      },
    });
    return { ewbNo: String(m.EwbNo), ewbDate: fromIrpTimestamp(m.EwbDt) ?? new Date().toISOString(), validTill: fromIrpTimestamp(m.EwbValidTill) };
  }
}
