import type {
  AdvanceTicketInput,
  AuthUser,
  KdsStockItemDto,
  KdsTicketDto,
  LoginResponse,
  OutletDto,
  StationDto,
} from "@petpooja/shared";

const BASE = "/api/v1";

let token: string | null = localStorage.getItem("kds.token");

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem("kds.token", t);
  else localStorage.removeItem("kds.token");
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
      message = (await res.json()).message ?? message;
    } catch {
      /* keep default */
    }
    if (res.status === 401) setToken(null);
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<AuthUser>("/auth/me"),
  outlets: () => request<OutletDto[]>("/outlets"),
  stations: (outletId: string) => request<StationDto[]>(`/outlets/${outletId}/kds/stations`),
  tickets: (outletId: string) => request<KdsTicketDto[]>(`/outlets/${outletId}/kds/tickets`),
  stock: (outletId: string) => request<KdsStockItemDto[]>(`/outlets/${outletId}/kds/stock`),
  advance: (kotId: string, input: AdvanceTicketInput) =>
    request<{ ok: true }>(`/kds/kots/${kotId}/advance`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  toggleStock: (outletId: string, itemId: string, inStock: boolean) =>
    request<{ id: string; inStock: boolean }>(`/outlets/${outletId}/menu/items/${itemId}/stock`, {
      method: "PATCH",
      body: JSON.stringify({ inStock }),
    }),
};
