import type {
  CreatePurchaseOrderInput,
  CreateStockCountInput,
  ForecastAccuracyDto,
  ForecastDto,
  GoodsReceiptDto,
  MaterialPlanningDto,
  MaterialPlanningInput,
  MenuEngineeringDto,
  PoActionInput,
  PriceHistoryRowDto,
  ProcurementSettingsDto,
  ProcurementSettingsInput,
  ProcurementVendorDto,
  ProcurementVendorInput,
  PurchaseOrderDto,
  PurchaseOrderSummaryDto,
  RawMaterialDto,
  ReceiveGrnInput,
  StockCountDto,
  StockCountEntriesInput,
  StockCountSummaryDto,
  SuggestionsDto,
  SuggestionsToPosInput,
  SupplierBillDto,
  SupplierBillInput,
  SupplierPaymentDto,
  SupplierPaymentInput,
  UpdatePurchaseOrderInput,
  VendorPayableDto,
} from "@stello/shared";
import { request } from "./api";

const body = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });
const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : "";
};

/** Procurement, stock control & insights endpoints. */
export const procApi = {
  materials: (o: string) => request<RawMaterialDto[]>(`/outlets/${o}/inventory/materials`),

  settings: (o: string) => request<ProcurementSettingsDto>(`/outlets/${o}/procurement/settings`),
  saveSettings: (o: string, input: ProcurementSettingsInput) =>
    request<ProcurementSettingsDto>(`/outlets/${o}/procurement/settings`, body("PUT", input)),

  vendors: (o: string) => request<ProcurementVendorDto[]>(`/outlets/${o}/procurement/vendors`),
  createVendor: (o: string, input: ProcurementVendorInput) =>
    request<{ id: string }>(`/outlets/${o}/procurement/vendors`, body("POST", input)),
  updateVendor: (o: string, id: string, input: ProcurementVendorInput) =>
    request<{ id: string }>(`/outlets/${o}/procurement/vendors/${id}`, body("PATCH", input)),
  priceHistory: (o: string, f: { vendorId?: string; materialId?: string }) =>
    request<PriceHistoryRowDto[]>(`/outlets/${o}/procurement/price-history${qs(f)}`),

  purchaseOrders: (o: string, status?: string) =>
    request<PurchaseOrderSummaryDto[]>(`/outlets/${o}/procurement/purchase-orders${qs({ status })}`),
  purchaseOrder: (o: string, id: string) => request<PurchaseOrderDto>(`/outlets/${o}/procurement/purchase-orders/${id}`),
  createPurchaseOrder: (o: string, input: CreatePurchaseOrderInput) =>
    request<{ id: string; poNumber: string }>(`/outlets/${o}/procurement/purchase-orders`, body("POST", input)),
  updatePurchaseOrder: (o: string, id: string, input: UpdatePurchaseOrderInput) =>
    request<{ id: string }>(`/outlets/${o}/procurement/purchase-orders/${id}`, body("PATCH", input)),
  poAction: (o: string, id: string, input: PoActionInput) =>
    request<{ id: string; status: string }>(`/outlets/${o}/procurement/purchase-orders/${id}/actions`, body("POST", input)),
  receive: (o: string, id: string, input: ReceiveGrnInput) =>
    request<{ id: string; grnNumber: string; status: string; total: number; varianceAmount: number }>(
      `/outlets/${o}/procurement/purchase-orders/${id}/receive`,
      body("POST", input),
    ),
  receipts: (o: string) => request<GoodsReceiptDto[]>(`/outlets/${o}/procurement/receipts`),

  planning: (o: string) => request<MaterialPlanningDto[]>(`/outlets/${o}/procurement/planning`),
  savePlanning: (o: string, input: MaterialPlanningInput) =>
    request<{ updated: number }>(`/outlets/${o}/procurement/planning`, body("PUT", input)),
  suggestions: (o: string) => request<SuggestionsDto>(`/outlets/${o}/procurement/suggestions`),
  suggestionsToPos: (o: string, input: SuggestionsToPosInput) =>
    request<{ id: string; poNumber: string; vendorId: string }[]>(
      `/outlets/${o}/procurement/suggestions/purchase-orders`,
      body("POST", input),
    ),

  forecast: (o: string, days: number) => request<ForecastDto>(`/outlets/${o}/procurement/forecast?days=${days}`),
  forecastAccuracy: (o: string, days: number) =>
    request<ForecastAccuracyDto>(`/outlets/${o}/procurement/forecast/accuracy?days=${days}`),

  payables: (o: string) => request<VendorPayableDto[]>(`/outlets/${o}/payables`),
  bills: (o: string, f: { vendorId?: string; status?: string } = {}) =>
    request<SupplierBillDto[]>(`/outlets/${o}/payables/bills${qs(f)}`),
  createBill: (o: string, input: SupplierBillInput) => request<{ id: string }>(`/outlets/${o}/payables/bills`, body("POST", input)),
  voidBill: (o: string, id: string) => request<{ id: string }>(`/outlets/${o}/payables/bills/${id}/void`, { method: "POST" }),
  payments: (o: string, vendorId?: string) => request<SupplierPaymentDto[]>(`/outlets/${o}/payables/payments${qs({ vendorId })}`),
  pay: (o: string, input: SupplierPaymentInput) =>
    request<{ id: string; allocated: number; unallocated: number }>(`/outlets/${o}/payables/payments`, body("POST", input)),

  stockCounts: (o: string) => request<StockCountSummaryDto[]>(`/outlets/${o}/stocktakes`),
  stockCountCategories: (o: string) => request<string[]>(`/outlets/${o}/stocktakes/categories`),
  stockCount: (o: string, id: string) => request<StockCountDto>(`/outlets/${o}/stocktakes/${id}`),
  createStockCount: (o: string, input: CreateStockCountInput) =>
    request<{ id: string; countNumber: string }>(`/outlets/${o}/stocktakes`, body("POST", input)),
  saveCounts: (o: string, id: string, input: StockCountEntriesInput) =>
    request<{ id: string }>(`/outlets/${o}/stocktakes/${id}/counts`, body("PUT", input)),
  submitCount: (o: string, id: string) => request<{ id: string }>(`/outlets/${o}/stocktakes/${id}/submit`, { method: "POST" }),
  cancelCount: (o: string, id: string) => request<{ id: string }>(`/outlets/${o}/stocktakes/${id}/cancel`, { method: "POST" }),
  postCount: (o: string, id: string) =>
    request<{ id: string; adjusted: number; varianceValue: number }>(`/outlets/${o}/stocktakes/${id}/post`, { method: "POST" }),

  menuEngineering: (o: string, from: string, to: string, categoryId?: string) =>
    request<MenuEngineeringDto>(`/outlets/${o}/reports/menu-engineering${qs({ from, to, categoryId })}`),
};

export const inr = (n: number, digits = 2) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
export const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
export const errMsg = (e: unknown, fallback = "Action failed") => (e instanceof Error ? e.message : fallback);
