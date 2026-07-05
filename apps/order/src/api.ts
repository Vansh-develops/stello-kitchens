import type {
  OrderRequestStatusDto,
  PublicMenuDto,
  SubmitOrderRequestInput,
  TokenBoardDto,
} from "@petpooja/shared";

const BASE = "/api/v1/public/scan";

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  tableMenu: (token: string) => req<PublicMenuDto>(`/t/${token}`),
  kioskMenu: (token: string) => req<PublicMenuDto>(`/kiosk/${token}`),
  submitTable: (token: string, body: SubmitOrderRequestInput) =>
    req<{ requestToken: string }>(`/t/${token}/order`, { method: "POST", body: JSON.stringify(body) }),
  submitKiosk: (token: string, body: SubmitOrderRequestInput) =>
    req<{ requestToken: string }>(`/kiosk/${token}/order`, { method: "POST", body: JSON.stringify(body) }),
  status: (requestToken: string) => req<OrderRequestStatusDto>(`/request/${requestToken}`),
  board: (token: string) => req<TokenBoardDto>(`/board/${token}`),
  callWaiter: (token: string) => req<{ tableName: string }>(`/t/${token}/call-waiter`, { method: "POST" }),
};
