import type {
  AddonGroupInput,
  AdminMenuDto,
  AggregatorOrderDto,
  AuthUser,
  CampaignDto,
  CampaignInput,
  CashSessionDto,
  CentralKitchenContextDto,
  ChannelInput,
  CreateIndentInput,
  EwayBillDto,
  IndentDto,
  OrderRequestDto,
  TableQrDto,
  ComboDto,
  CreateComboInput,
  PrepRecipeDto,
  SetPrepRecipeInput,
  ConsumptionRowDto,
  CouponDto,
  CouponInput,
  ReconciliationRowDto,
  CreateCategoryInput,
  CreateItemInput,
  CreateMaterialInput,
  CustomerDetailDto,
  CustomerDto,
  CustomerSummaryDto,
  DayEndReportDto,
  FeedbackDto,
  FraudReportDto,
  InvoiceDto,
  InvoiceRowDto,
  OutletKpiDto,
  CustomReportDto,
  CustomReportInput,
  DeviceDto,
  CreateDeviceInput,
  UpdateDeviceInput,
  OutletBackupDto,
  ReportBreakdownDto,
  ReportOverviewDto,
  ItemCostDto,
  ItemRecipeDto,
  LoginResponse,
  LoyaltyAdjustInput,
  OutletDto,
  RawMaterialDto,
  ReceiveStockInput,
  SetRecipeInput,
  UpdateCategoryInput,
  UpdateItemInput,
  UpdateMaterialInput,
  VendorDto,
  VendorInput,
  WastageInput,
} from "@stello/shared";

const BASE = "/api/v1";

let token: string | null = typeof window !== "undefined" ? localStorage.getItem("dash.token") : null;

export function setToken(t: string | null) {
  token = t;
  if (typeof window === "undefined") return;
  if (t) localStorage.setItem("dash.token", t);
  else localStorage.removeItem("dash.token");
}

export function hasToken() {
  return !!token;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body.message ?? message;
      if (Array.isArray(body.errors)) {
        message += ": " + body.errors.map((e: { path: string; message: string }) => `${e.path} ${e.message}`).join(", ");
      }
    } catch {
      /* keep default */
    }
    if (res.status === 401) setToken(null);
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  // A `null` controller return arrives as a 200 with an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => request<AuthUser>("/auth/me"),
  outlets: () => request<OutletDto[]>("/outlets"),
  adminMenu: (outletId: string) => request<AdminMenuDto>(`/outlets/${outletId}/menu/admin`),

  createCategory: (outletId: string, input: CreateCategoryInput) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/categories`, { method: "POST", body: JSON.stringify(input) }),
  updateCategory: (outletId: string, id: string, input: UpdateCategoryInput) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/categories/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteCategory: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/categories/${id}`, { method: "DELETE" }),

  createItem: (outletId: string, input: CreateItemInput) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/items`, { method: "POST", body: JSON.stringify(input) }),
  updateItem: (outletId: string, id: string, input: UpdateItemInput) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/items/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteItem: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/items/${id}`, { method: "DELETE" }),
  toggleStock: (outletId: string, itemId: string, inStock: boolean) =>
    request<{ id: string; inStock: boolean }>(`/outlets/${outletId}/menu/items/${itemId}/stock`, {
      method: "PATCH",
      body: JSON.stringify({ inStock }),
    }),

  createAddonGroup: (outletId: string, input: AddonGroupInput) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/addon-groups`, { method: "POST", body: JSON.stringify(input) }),
  updateAddonGroup: (outletId: string, id: string, input: AddonGroupInput) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/addon-groups/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAddonGroup: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/menu/addon-groups/${id}`, { method: "DELETE" }),

  createChannel: (outletId: string, input: ChannelInput) =>
    request<{ id: string }>(`/outlets/${outletId}/channels`, { method: "POST", body: JSON.stringify(input) }),
  updateChannel: (outletId: string, id: string, input: Partial<ChannelInput>) =>
    request<{ id: string }>(`/outlets/${outletId}/channels/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteChannel: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/channels/${id}`, { method: "DELETE" }),

  // Inventory
  materials: (outletId: string) => request<RawMaterialDto[]>(`/outlets/${outletId}/inventory/materials`),
  createMaterial: (outletId: string, input: CreateMaterialInput) =>
    request<{ id: string }>(`/outlets/${outletId}/inventory/materials`, { method: "POST", body: JSON.stringify(input) }),
  updateMaterial: (outletId: string, id: string, input: UpdateMaterialInput) =>
    request<{ id: string }>(`/outlets/${outletId}/inventory/materials/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteMaterial: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/inventory/materials/${id}`, { method: "DELETE" }),
  receiveStock: (outletId: string, id: string, input: ReceiveStockInput) =>
    request<{ id: string; stockQty: number; costPerUnit: number }>(
      `/outlets/${outletId}/inventory/materials/${id}/receive`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  recordWastage: (outletId: string, id: string, input: WastageInput) =>
    request<{ id: string; stockQty: number }>(`/outlets/${outletId}/inventory/materials/${id}/wastage`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  vendors: (outletId: string) => request<VendorDto[]>(`/outlets/${outletId}/inventory/vendors`),
  createVendor: (outletId: string, input: VendorInput) =>
    request<{ id: string }>(`/outlets/${outletId}/inventory/vendors`, { method: "POST", body: JSON.stringify(input) }),
  deleteVendor: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/inventory/vendors/${id}`, { method: "DELETE" }),
  costing: (outletId: string) => request<ItemCostDto[]>(`/outlets/${outletId}/inventory/costing`),
  consumption: (outletId: string, days: number) =>
    request<ConsumptionRowDto[]>(`/outlets/${outletId}/inventory/consumption?days=${days}`),
  recipe: (outletId: string, itemId: string) =>
    request<ItemRecipeDto>(`/outlets/${outletId}/menu/items/${itemId}/recipe`),
  setRecipe: (outletId: string, itemId: string, input: SetRecipeInput) =>
    request<{ itemId: string }>(`/outlets/${outletId}/menu/items/${itemId}/recipe`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  // Aggregators
  aggregatorOrders: (outletId: string) =>
    request<AggregatorOrderDto[]>(`/outlets/${outletId}/aggregator/orders`),
  aggregatorReconciliation: (outletId: string) =>
    request<ReconciliationRowDto[]>(`/outlets/${outletId}/aggregator/reconciliation`),

  // CRM
  customers: (outletId: string) => request<CustomerDto[]>(`/outlets/${outletId}/customers`),
  customerSummary: (outletId: string) => request<CustomerSummaryDto>(`/outlets/${outletId}/customers/summary`),
  customerDetail: (outletId: string, id: string) =>
    request<CustomerDetailDto>(`/outlets/${outletId}/customers/${id}`),
  adjustLoyalty: (outletId: string, id: string, input: LoyaltyAdjustInput) =>
    request<{ id: string; points: number }>(`/outlets/${outletId}/customers/${id}/loyalty`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  coupons: (outletId: string) => request<CouponDto[]>(`/outlets/${outletId}/coupons`),
  createCoupon: (outletId: string, input: CouponInput) =>
    request<{ id: string }>(`/outlets/${outletId}/coupons`, { method: "POST", body: JSON.stringify(input) }),
  setCouponActive: (outletId: string, id: string, isActive: boolean) =>
    request<{ id: string }>(`/outlets/${outletId}/coupons/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive }),
    }),
  deleteCoupon: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/coupons/${id}`, { method: "DELETE" }),
  campaigns: (outletId: string) => request<CampaignDto[]>(`/outlets/${outletId}/campaigns`),
  createCampaign: (outletId: string, input: CampaignInput) =>
    request<{ id: string }>(`/outlets/${outletId}/campaigns`, { method: "POST", body: JSON.stringify(input) }),
  sendCampaign: (outletId: string, id: string) =>
    request<{ id: string; sent: number }>(`/outlets/${outletId}/campaigns/${id}/send`, { method: "POST" }),
  feedback: (outletId: string) => request<FeedbackDto[]>(`/outlets/${outletId}/feedback`),

  // Reports
  reportOverview: (outletId: string, from: string, to: string) =>
    request<ReportOverviewDto>(`/outlets/${outletId}/reports/overview?from=${from}&to=${to}`),
  reportBreakdown: (outletId: string, from: string, to: string) =>
    request<ReportBreakdownDto>(`/outlets/${outletId}/reports/breakdown?from=${from}&to=${to}`),
  reportDayEnd: (outletId: string, date: string) =>
    request<DayEndReportDto>(`/outlets/${outletId}/reports/day-end?date=${date}`),
  reportFraud: (outletId: string, from: string, to: string) =>
    request<FraudReportDto>(`/outlets/${outletId}/reports/fraud?from=${from}&to=${to}`),
  reportOutlets: (from: string, to: string) =>
    request<OutletKpiDto[]>(`/reports/outlets?from=${from}&to=${to}`),
  reportCustom: (outletId: string, input: CustomReportInput) =>
    request<CustomReportDto>(`/outlets/${outletId}/reports/custom`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cashSessions: (outletId: string) => request<CashSessionDto[]>(`/outlets/${outletId}/cash/sessions`),

  // Accounting / GST
  invoices: (outletId: string, from: string, to: string) =>
    request<InvoiceRowDto[]>(`/outlets/${outletId}/invoices?from=${from}&to=${to}`),
  invoice: (outletId: string, orderId: string) =>
    request<InvoiceDto>(`/outlets/${outletId}/invoices/${orderId}`),
  generateIrn: (outletId: string, orderId: string, buyerGstin?: string) =>
    request<InvoiceDto>(`/outlets/${outletId}/invoices/${orderId}/irn`, {
      method: "POST",
      body: JSON.stringify({ buyerGstin }),
    }),
  tallyExport: (outletId: string, from: string, to: string) =>
    request<{ filename: string; xml: string }>(`/outlets/${outletId}/exports/tally?from=${from}&to=${to}`),

  // Central kitchen
  ckContext: (outletId: string) =>
    request<CentralKitchenContextDto>(`/outlets/${outletId}/central-kitchen/context`),
  ckIndents: (outletId: string) => request<IndentDto[]>(`/outlets/${outletId}/central-kitchen/indents`),
  ckCreateIndent: (outletId: string, input: CreateIndentInput) =>
    request<{ id: string }>(`/outlets/${outletId}/central-kitchen/indents`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  ckDispatch: (outletId: string, id: string) =>
    request<{ id: string; status: string }>(`/outlets/${outletId}/central-kitchen/indents/${id}/dispatch`, { method: "POST" }),
  ckReceive: (outletId: string, id: string) =>
    request<{ id: string; status: string }>(`/outlets/${outletId}/central-kitchen/indents/${id}/receive`, { method: "POST" }),
  ckEwayBill: (outletId: string, id: string, distanceKm?: number) =>
    request<EwayBillDto>(`/outlets/${outletId}/central-kitchen/indents/${id}/eway-bill`, {
      method: "POST",
      body: JSON.stringify({ distanceKm }),
    }),

  // Scan & Order (validation queue + QR links)
  scanRequests: (outletId: string) =>
    request<OrderRequestDto[]>(`/outlets/${outletId}/scan-requests`),
  scanAccept: (outletId: string, id: string) =>
    request<OrderRequestDto>(`/outlets/${outletId}/scan-requests/${id}/accept`, { method: "POST" }),
  scanReject: (outletId: string, id: string) =>
    request<OrderRequestDto>(`/outlets/${outletId}/scan-requests/${id}/reject`, { method: "POST" }),
  scanTableQrs: (outletId: string) =>
    request<TableQrDto[]>(`/outlets/${outletId}/scan-requests/table-qrs`),
  scanPublicToken: (outletId: string) =>
    request<{ token: string | null }>(`/outlets/${outletId}/scan-requests/public-token`),

  // Combos
  combos: (outletId: string) => request<ComboDto[]>(`/outlets/${outletId}/combos`),
  comboCreate: (outletId: string, input: CreateComboInput) =>
    request<ComboDto>(`/outlets/${outletId}/combos`, { method: "POST", body: JSON.stringify(input) }),
  comboDelete: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/combos/${id}`, { method: "DELETE" }),
  comboStock: (outletId: string, id: string, inStock: boolean) =>
    request<{ id: string; inStock: boolean }>(`/outlets/${outletId}/combos/${id}/stock`, {
      method: "PATCH",
      body: JSON.stringify({ inStock }),
    }),

  // Multi-stage recipes (semi-finished goods)
  prepRecipe: (outletId: string, materialId: string) =>
    request<PrepRecipeDto>(`/outlets/${outletId}/inventory/materials/${materialId}/prep-recipe`),
  setPrepRecipe: (outletId: string, materialId: string, input: SetPrepRecipeInput) =>
    request<{ materialId: string; isSemiFinished: boolean }>(
      `/outlets/${outletId}/inventory/materials/${materialId}/prep-recipe`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
  produceBatch: (outletId: string, materialId: string, quantity: number) =>
    request<{ id: string; stockQty: number; costPerUnit: number; batchCost: number }>(
      `/outlets/${outletId}/inventory/materials/${materialId}/produce`,
      { method: "POST", body: JSON.stringify({ quantity }) },
    ),

  // Device fleet
  devices: (outletId: string) => request<DeviceDto[]>(`/outlets/${outletId}/devices`),
  deviceCreate: (outletId: string, input: CreateDeviceInput) =>
    request<DeviceDto>(`/outlets/${outletId}/devices`, { method: "POST", body: JSON.stringify(input) }),
  deviceUpdate: (outletId: string, id: string, input: UpdateDeviceInput) =>
    request<DeviceDto>(`/outlets/${outletId}/devices/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deviceDelete: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/devices/${id}`, { method: "DELETE" }),
  deviceBackup: (outletId: string) => request<OutletBackupDto>(`/outlets/${outletId}/devices/backup`),
  deviceHeartbeat: (deviceToken: string) =>
    request<{ ok: boolean }>(`/public/devices/heartbeat`, { method: "POST", body: JSON.stringify({ deviceToken }) }),

  // Brand appearance
  setBrandTheme: (brandId: string, themeId: string) =>
    request<{ id: string; themeId: string }>(`/brands/${brandId}/theme`, {
      method: "PATCH",
      body: JSON.stringify({ themeId }),
    }),
};
