import type { CashSessionDto, MenuCategoryDto } from "@petpooja/shared";

// The renderer talks ONLY to the local master service (sidecar) — never the cloud
// directly — so it operates identically online and offline.
const SIDECAR = "http://localhost:4010";

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SIDECAR}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.message ?? `Sidecar error ${res.status}`);
  return body as T;
}

export interface EdgeStatus {
  deviceId: string;
  outletId: string | null;
  outletName: string | null;
  pending: number;
  lastSyncAt: string | null;
  snapshotAt: string | null;
  forcedOffline: boolean;
  online: boolean;
}
export interface LocalOrderRow {
  clientId: string;
  status: string;
  synced: boolean;
  serverId: string | null;
  billNumber: string | null; // authoritative GST number, populated after sync
  offlineRef: string | null; // provisional device reference (offline receipt)
  total: number;
  orderType: string;
  tableId: string | null;
  lineCount: number;
}
export interface LocalOrder {
  clientId: string;
  total: number;
  offlineRef: string | null;
}

// CashSessionDto imported only to keep the shared dependency wired; not used directly.
void (0 as unknown as CashSessionDto);

export const edge = {
  status: () => call<EdgeStatus>("/status"),
  bootstrap: (email: string, password: string) =>
    call<{ outletId: string; outletName: string; deviceId: string }>("/bootstrap", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  menu: () => call<MenuCategoryDto[]>("/menu"),
  orders: () => call<LocalOrderRow[]>("/orders"),
  createOrder: (input: {
    orderType: string;
    items: { itemId: string; quantity: number; addonIds: string[] }[];
    customerName?: string;
    customerPhone?: string;
  }) => call<LocalOrder>("/orders", { method: "POST", body: JSON.stringify(input) }),
  settle: (clientId: string, payments: { mode: string; amount: number }[]) =>
    call<LocalOrder>(`/orders/${clientId}/settle`, { method: "POST", body: JSON.stringify({ payments }) }),
  sync: () => call<{ pushed: number; pending: number }>("/sync", { method: "POST" }),
  setOffline: (offline: boolean) =>
    call<{ forcedOffline: boolean }>("/offline", { method: "POST", body: JSON.stringify({ offline }) }),
};
