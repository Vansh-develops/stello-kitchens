import type { ComboDto, MenuItemDto, PaymentMode } from "@stello/shared";

// The renderer talks ONLY to the local master service (sidecar) — never the cloud
// directly — so it operates identically online and offline.
const SIDECAR = "http://localhost:4010";
const SIDECAR_TOKEN =
  typeof window !== "undefined" && window.edgeShell?.sidecarToken
    ? window.edgeShell.sidecarToken
    : "dev-edge-sidecar-token";

// The staff PIN session lives only in memory: closing the window logs out.
let staffSession: string | null = null;
let onSessionLost: (() => void) | null = null;
export function setStaffSession(token: string | null) {
  staffSession = token;
}
export function onStaffSessionLost(fn: () => void) {
  onSessionLost = fn;
}

export class SidecarError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SIDECAR}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Edge-Token": SIDECAR_TOKEN,
      ...(staffSession ? { "X-Staff-Session": staffSession } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (res.status === 401 && body?.code === "STAFF_LOGIN") onSessionLost?.();
  if (!res.ok) throw new SidecarError(body?.message ?? `Sidecar error ${res.status}`, res.status);
  return body as T;
}
const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export interface EdgeStatus {
  deviceId: string;
  terminalId: string | null;
  outletId: string | null;
  outletName: string | null;
  activated: boolean;
  seriesCode: string | null;
  pending: number;
  conflicts: number;
  lastSyncAt: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  authError: string | null;
  snapshotAt: string | null;
  clockSkewMs: number;
  themeId: string | null; // brand theme from the cached outlet settings; drives the renderer's look offline
  gstin: string | null;
  forcedOffline: boolean;
  online: boolean;
  lanKds: { port: number; urls: string[] } | null;
}

export interface StaffRow {
  id: string;
  name: string;
  roleName: string;
  hasPin: boolean;
}
export interface StaffSession {
  id: string;
  name: string;
  roleName: string;
  permissions: string[];
}
export const can = (s: StaffSession | null, perm: string) => !!s && (s.permissions.includes("*") || s.permissions.includes(perm));

export interface EdgeCategory {
  id: string;
  name: string;
  sortOrder: number;
  stationName: string | null;
  items: MenuItemDto[];
  combos: ComboDto[];
}
export interface EdgeTable {
  id: string;
  name: string;
  seats: number;
  occupiedByOrderId: string | null;
  runningTotal: number | null;
  cloudOccupied: boolean;
}
export interface EdgeArea {
  id: string;
  name: string;
  tables: EdgeTable[];
}
export interface EdgeSettings {
  name: string;
  address: string | null;
  gstin: string | null;
  upiVpa: string | null;
  themeId: string;
}

export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";
export interface ItemLineInput {
  itemId: string;
  variationId?: string;
  addonIds: string[];
  quantity: number;
  note?: string;
}
export interface ComboLineInput {
  comboId: string;
  quantity: number;
  note?: string;
  selections: { slotId: string; itemId: string }[];
}
export interface LocalLine {
  kind?: "item" | "combo";
  itemName: string;
  variationName: string | null;
  addonNames: string[];
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  taxRate: number;
  note?: string;
  kotNo?: number;
  prepStatus?: string;
}
export interface PaymentInput {
  mode: PaymentMode;
  amount: number;
  reference?: string;
}
export interface LocalOrder {
  clientId: string;
  orderType: OrderType;
  tableId: string | null;
  tableName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  lines: LocalLine[];
  payments: PaymentInput[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  manualDiscount: number;
  couponCode: string | null;
  couponDiscount: number;
  status: "OPEN" | "SETTLED" | "CANCELLED";
  billNo: { series: string; fy: string; seq: number; number: string } | null;
  offlineRef: string | null;
  billNumber: string | null;
  syncState?: string;
  kotCount: number;
  createdAt: string;
  closedAt: string | null;
}
export interface LocalOrderRow {
  clientId: string;
  status: string;
  synced: boolean;
  syncState: string;
  serverId: string | null;
  billNumber: string | null; // number the cloud filed the invoice under
  offlineRef: string | null; // device invoice number printed on the receipt
  total: number;
  orderType: OrderType;
  tableId: string | null;
  tableName: string | null;
  customerName: string | null;
  lineCount: number;
  createdAt: string;
  closedAt: string | null;
}
export interface CouponPreview {
  valid: boolean;
  discount: number;
  message: string;
  code: string | null;
  limited: boolean;
}
export interface OutboxRow {
  id: number;
  key: string;
  kind: string;
  clientId: string;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  doneAt: string | null;
}
export interface ConflictRow {
  id: number;
  clientId: string;
  billNumber: string | null;
  kind: string;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
}
export interface KdsScreen {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export const edge = {
  status: () => call<EdgeStatus>("/status"),
  bootstrap: (email: string, password: string, outletId?: string) =>
    post<{ outletId: string; outletName: string; deviceId: string; seriesCode: string }>("/bootstrap", { email, password, ...(outletId ? { outletId } : {}) }),
  menu: () => call<EdgeCategory[]>("/menu"),
  areas: () => call<EdgeArea[]>("/areas"),
  settings: () => call<EdgeSettings | null>("/settings"),

  staff: () => call<StaffRow[]>("/staff"),
  pinLogin: (staffId: string, pin: string) => post<{ token: string; staff: StaffSession }>("/auth/pin", { staffId, pin }),
  logout: () => post<{ ok: true }>("/auth/logout"),

  orders: (status?: string) => call<LocalOrderRow[]>(`/orders${status ? `?status=${status}` : ""}`),
  order: (clientId: string) => call<LocalOrder>(`/orders/${clientId}`),
  createOrder: (input: {
    orderType: OrderType;
    tableId?: string;
    customerName?: string;
    customerPhone?: string;
    deliveryAddress?: string;
    items: ItemLineInput[];
    combos: ComboLineInput[];
    allowCloudOccupied?: boolean;
  }) => post<LocalOrder>("/orders", input),
  addItems: (clientId: string, items: ItemLineInput[], combos: ComboLineInput[]) => post<LocalOrder>(`/orders/${clientId}/items`, { items, combos }),
  settle: (clientId: string, input: { payments: PaymentInput[]; discountAmount?: number; couponCode?: string | null }) =>
    post<LocalOrder>(`/orders/${clientId}/settle`, input),
  cancel: (clientId: string, reason: string) => post<LocalOrder>(`/orders/${clientId}/cancel`, { reason }),
  previewCoupon: (code: string, subtotal: number) => post<CouponPreview>("/coupons/preview", { code, subtotal }),

  syncState: () => call<{ status: EdgeStatus; outbox: OutboxRow[]; conflicts: ConflictRow[] }>("/sync/state"),
  sync: () => post<{ pushed: number; pulled: number; pending: number; conflicts: number }>("/sync"),
  ackConflict: (id: number) => post<{ ok: true }>(`/conflicts/${id}/ack`),
  setOffline: (offline: boolean) => post<{ forcedOffline: boolean }>("/offline", { offline }),

  pairingCode: () => post<{ code: string; expiresAt: string; lan: { port: number; urls: string[] } | null }>("/kds/pairing-code"),
  screens: () => call<KdsScreen[]>("/kds/screens"),
  revokeScreen: (id: string) => post<{ ok: true }>(`/kds/screens/${id}/revoke`),
};
