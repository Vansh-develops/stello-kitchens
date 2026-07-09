import type {
  AddItemsInput,
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
};
