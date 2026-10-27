import type {
  AddItemsInput,
  BillingSettingsDto,
  BillPreviewDto,
  MergeOrdersInput,
  ParkCartInput,
  ParkedCartDto,
  SettlePreviewInput,
  SplitOrderInput,
  TransferOrderInput,
  AreaDto,
  CashMovementInput,
  CashSessionDto,
  CashSessionReportDto,
  CouponPreviewDto,
  CreateOrderInput,
  CustomerLookupDto,
  MenuCategoryDto,
  OrderDto,
  SettleOrderInput,
  UpiQrDto,
} from "@stello/shared";
import { request } from "./api";

// POS-specific endpoints, mirroring apps/pos/src/api.ts's `api` object.
// Token/session handling (setToken/hasToken/login/me/outlets) is already
// owned by the shared client in ./api — this only adds the counter methods.
export const posApi = {
  tables: (outletId: string) => request<AreaDto[]>(`/outlets/${outletId}/tables`),
  menu: (outletId: string) => request<MenuCategoryDto[]>(`/outlets/${outletId}/menu`),
  openOrders: (outletId: string) => request<OrderDto[]>(`/orders?outletId=${outletId}`),
  order: (id: string) => request<OrderDto>(`/orders/${id}`),
  createOrder: (input: CreateOrderInput) =>
    request<OrderDto>("/orders", { method: "POST", body: JSON.stringify(input) }),
  addItems: (orderId: string, input: AddItemsInput) =>
    request<OrderDto>(`/orders/${orderId}/items`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  settle: (orderId: string, input: SettleOrderInput) =>
    request<OrderDto>(`/orders/${orderId}/settle`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancel: (orderId: string) => request<OrderDto>(`/orders/${orderId}/cancel`, { method: "POST" }),
  lookupCustomer: (outletId: string, phone: string) =>
    request<CustomerLookupDto>(`/outlets/${outletId}/customers/by-phone?phone=${encodeURIComponent(phone)}`),
  previewCoupon: (outletId: string, code: string, subtotal: number) =>
    request<CouponPreviewDto>(
      `/outlets/${outletId}/coupons/preview?code=${encodeURIComponent(code)}&subtotal=${subtotal}`,
    ),
  requestLoyaltyOtp: (outletId: string, phone: string) =>
    request<{ sent: boolean; points: number; expiresInSec: number }>(
      `/outlets/${outletId}/loyalty/request-otp`,
      { method: "POST", body: JSON.stringify({ phone }) },
    ),
  cashCurrent: (outletId: string) => request<CashSessionDto | null>(`/outlets/${outletId}/cash/current`),
  cashOpen: (outletId: string, openingFloat: number) =>
    request<{ id: string }>(`/outlets/${outletId}/cash/open`, { method: "POST", body: JSON.stringify({ openingFloat }) }),
  cashClose: (outletId: string, countedCash: number) =>
    request<CashSessionReportDto>(`/outlets/${outletId}/cash/close`, {
      method: "POST",
      body: JSON.stringify({ countedCash }),
    }),
  cashMovement: (outletId: string, input: CashMovementInput) =>
    request<{ ok: true }>(`/outlets/${outletId}/cash/movement`, { method: "POST", body: JSON.stringify(input) }),
  upiQr: (outletId: string, orderId: string, amount?: number) =>
    request<UpiQrDto>(`/outlets/${outletId}/payments/${orderId}/upi-qr`, {
      method: "POST",
      body: JSON.stringify({ amount }),
    }),
  // Billing controls
  billingSettings: (outletId: string) => request<BillingSettingsDto>(`/outlets/${outletId}/billing-settings`),
  preview: (orderId: string, input: SettlePreviewInput) =>
    request<BillPreviewDto>(`/orders/${orderId}/preview`, { method: "POST", body: JSON.stringify(input) }),
  removeServiceCharge: (orderId: string, reason: string) =>
    request<OrderDto>(`/orders/${orderId}/service-charge/remove`, { method: "POST", body: JSON.stringify({ reason }) }),
  restoreServiceCharge: (orderId: string) =>
    request<OrderDto>(`/orders/${orderId}/service-charge/restore`, { method: "POST" }),
  merge: (orderId: string, input: MergeOrdersInput) =>
    request<OrderDto>(`/orders/${orderId}/merge`, { method: "POST", body: JSON.stringify(input) }),
  transfer: (orderId: string, input: TransferOrderInput) =>
    request<{ from: OrderDto | null; to: OrderDto }>(`/orders/${orderId}/transfer`, { method: "POST", body: JSON.stringify(input) }),
  split: (orderId: string, input: SplitOrderInput) =>
    request<OrderDto>(`/orders/${orderId}/split`, { method: "POST", body: JSON.stringify(input) }),
  unsplit: (orderId: string) => request<OrderDto>(`/orders/${orderId}/unsplit`, { method: "POST" }),
  parked: (outletId: string) => request<ParkedCartDto[]>(`/outlets/${outletId}/parked`),
  park: (outletId: string, input: ParkCartInput) =>
    request<ParkedCartDto>(`/outlets/${outletId}/parked`, { method: "POST", body: JSON.stringify(input) }),
  resumeParked: (id: string) => request<ParkedCartDto>(`/parked/${id}/resume`, { method: "POST" }),
  discardParked: (id: string) => request<{ ok: true }>(`/parked/${id}`, { method: "DELETE" }),
};
