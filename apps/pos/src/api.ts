import type {
  AddItemsInput,
  AreaDto,
  AuthUser,
  CashMovementInput,
  CashSessionDto,
  CashSessionReportDto,
  CouponPreviewDto,
  CreateOrderInput,
  CustomerLookupDto,
  LoginResponse,
  MenuCategoryDto,
  OrderDto,
  OutletDto,
  SettleOrderInput,
  UpiQrDto,
} from "@stello/shared";

const BASE = "/api/v1";

let token: string | null = localStorage.getItem("pos.token");

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem("pos.token", t);
  else localStorage.removeItem("pos.token");
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
    } catch {
      /* keep default */
    }
    if (res.status === 401) setToken(null);
    throw new ApiError(message, res.status);
  }
  // A `null` controller return arrives as a 200 with an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<AuthUser>("/auth/me"),
  outlets: () => request<OutletDto[]>("/outlets"),
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
