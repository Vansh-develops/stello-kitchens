import { z } from "zod";
import type { AuthUser } from "./types";

// ───────────────────────── Permission catalogue ─────────────────────────
//
// The single source of truth for permission keys. The API gates routes with
// `@RequirePermission(key)`; the role editor renders this catalogue grouped and
// described; API keys are scoped with the same keys. "*" (owner) implies all.

export interface PermissionDef {
  key: string;
  group: PermissionGroup;
  label: string;
  description: string;
}

export type PermissionGroup =
  | "Orders & billing"
  | "Kitchen"
  | "Menu"
  | "Inventory"
  | "Customers & marketing"
  | "Reports"
  | "Finance"
  | "Administration";

export const PERMISSION_GROUPS: PermissionGroup[] = [
  "Orders & billing",
  "Kitchen",
  "Menu",
  "Inventory",
  "Customers & marketing",
  "Reports",
  "Finance",
  "Administration",
];

export const PERMISSIONS: PermissionDef[] = [
  { key: "orders.view", group: "Orders & billing", label: "View orders", description: "Read orders and bills (used by integrations and API keys)." },
  { key: "orders.create", group: "Orders & billing", label: "Take orders", description: "Open orders, add items and fire KOTs from the POS." },
  { key: "orders.settle", group: "Orders & billing", label: "Settle bills", description: "Take payment, apply discounts and close orders; use the POS." },
  { key: "orders.cancel", group: "Orders & billing", label: "Cancel orders", description: "Void open orders. Cancellations show up in the fraud watch." },
  { key: "kds.operate", group: "Kitchen", label: "Operate KDS", description: "Use the kitchen display and bump tickets through prep stages." },
  { key: "menu.stock", group: "Menu", label: "86 items", description: "Mark items in or out of stock." },
  { key: "menu.manage", group: "Menu", label: "Edit menu", description: "Create and edit categories, items, prices, add-ons and combos." },
  { key: "inventory.manage", group: "Inventory", label: "Manage inventory", description: "Raw materials, vendors, receipts, wastage, recipes and central kitchen." },
  { key: "crm.manage", group: "Customers & marketing", label: "Customers & marketing", description: "Customer records, loyalty, coupons, campaigns and feedback." },
  { key: "reports.view", group: "Reports", label: "View reports", description: "Sales, breakdown, day-end and fraud reports in the console." },
  { key: "reports.export", group: "Reports", label: "Export reports", description: "Download reports as CSV or Excel." },
  { key: "reports.schedule", group: "Reports", label: "Schedule report emails", description: "Set up daily/weekly report emails to any recipient." },
  { key: "finance.manage", group: "Finance", label: "Finance & GST", description: "Invoices, e-invoicing (IRN), refunds and accounting exports." },
  { key: "devices.manage", group: "Administration", label: "Manage devices", description: "Register POS terminals, KDS screens and printers." },
  { key: "settings.manage", group: "Administration", label: "Outlet settings", description: "Outlet details, tables, appearance, invites and security policy." },
  { key: "roles.manage", group: "Administration", label: "Manage roles & staff", description: "Create and edit roles and change which role a staff member has." },
  { key: "audit.view", group: "Administration", label: "View audit log", description: "Browse the tenant audit trail of sign-ins and sensitive actions." },
  { key: "integrations.manage", group: "Administration", label: "API keys & webhooks", description: "Issue API keys, configure webhooks and inspect deliveries." },
];

export const PERMISSION_KEYS: string[] = PERMISSIONS.map((p) => p.key);

/** A permission key looks like `area.action` (lowercase, dot-separated). */
export const PermissionKeySchema = z
  .string()
  .regex(/^(\*|[a-z][a-z_]*(\.[a-z][a-z_]*)+)$/, "Invalid permission key");

/** True when `held` grants `perm` ("*" grants everything). */
export function hasPermission(held: readonly string[], perm: string): boolean {
  return held.includes("*") || held.includes(perm);
}

/**
 * Escalation guard: the keys in `requested` that `held` does NOT already cover.
 * Granting "*" requires holding "*". An empty result means the grant is allowed.
 */
export function missingPermissions(held: readonly string[], requested: readonly string[]): string[] {
  if (held.includes("*")) return [];
  return [...new Set(requested)].filter((p) => p === "*" || !held.includes(p));
}

/** Owner-level = holds the wildcard. Used for "last owner" and MFA policy. */
export function isOwnerLevel(permissions: readonly string[]): boolean {
  return permissions.includes("*");
}

/** Group arbitrary keys for display, with uncatalogued keys under "Other". */
export function groupPermissions(keys: readonly string[]): { group: string; perms: PermissionDef[] }[] {
  const out = PERMISSION_GROUPS.map((g) => ({
    group: g as string,
    perms: PERMISSIONS.filter((p) => p.group === g && keys.includes(p.key)),
  })).filter((g) => g.perms.length > 0);
  const extra = keys.filter((k) => k !== "*" && !PERMISSION_KEYS.includes(k));
  if (extra.length) {
    out.push({
      group: "Other",
      perms: extra.map((k) => ({ key: k, group: "Administration", label: k, description: "Custom permission" })),
    });
  }
  return out;
}

// ───────────────────────── Sessions & 2FA ─────────────────────────

export const SESSION_COOKIE = "stello_session";
export const CSRF_COOKIE = "stello_csrf";
export const CSRF_HEADER = "x-csrf-token";
/** Browser clients send this on login to receive an httpOnly cookie session. */
export const SESSION_MODE_HEADER = "x-session-mode";

/** Cookie-mode login result: the session itself lives in an httpOnly cookie. */
export interface CookieSessionResponse {
  user: AuthUser;
  csrfToken: string;
}

/** Password was right but a second factor is needed (verify or first enrolment). */
export interface MfaChallengeResponse {
  mfa: "verify" | "enroll";
  mfaToken: string;
}

export const MfaCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });
export type MfaCodeInput = z.infer<typeof MfaCodeSchema>;

export const MfaChallengeSchema = z
  .object({
    mfaToken: z.string().min(1),
    code: z.string().trim().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().trim().min(8).max(20).optional(),
  })
  .refine((v) => !!v.code !== !!v.recoveryCode, { message: "Provide either a code or a recovery code" });
export type MfaChallengeInput = z.infer<typeof MfaChallengeSchema>;

export const MfaTokenSchema = z.object({ mfaToken: z.string().min(1) });
export const MfaEnrollConfirmSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export type MfaEnrollConfirmInput = z.infer<typeof MfaEnrollConfirmSchema>;

export const PasswordConfirmSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().regex(/^\d{6}$/).optional(),
});
export type PasswordConfirmInput = z.infer<typeof PasswordConfirmSchema>;

export interface MfaStatusDto {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  requiredByPolicy: boolean;
}

export interface MfaSetupDto {
  secret: string; // base32, for manual entry
  otpauthUrl: string; // render as QR
}

export interface MfaEnabledDto {
  recoveryCodes: string[]; // shown once
}

export interface SecuritySettingsDto {
  requireOwnerMfa: boolean;
}
export const SecuritySettingsSchema = z.object({ requireOwnerMfa: z.boolean() });
export type SecuritySettingsInput = z.infer<typeof SecuritySettingsSchema>;

// ───────────────────────── Roles & staff ─────────────────────────

export const RoleInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  permissions: z.array(PermissionKeySchema).max(100),
});
export type RoleInput = z.infer<typeof RoleInputSchema>;

export interface RoleDetailDto {
  id: string;
  name: string;
  permissions: string[];
  userCount: number;
  isOwnerRole: boolean;
}

export interface StaffDto {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  isActive: boolean;
  mfaEnabled: boolean;
}

export const AssignRoleSchema = z.object({ roleId: z.string().min(1) });
export type AssignRoleInput = z.infer<typeof AssignRoleSchema>;

// ───────────────────────── Audit log ─────────────────────────

export const AuditQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  actorId: z.string().optional(),
  action: z.string().optional(),
  entity: z.string().optional(),
  entityId: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type AuditQueryInput = z.infer<typeof AuditQuerySchema>;

export interface AuditLogDto {
  id: string;
  createdAt: string;
  action: string;
  entity: string;
  entityId: string | null;
  actor: { id: string; name: string; email: string } | null;
  data: unknown;
}

export interface AuditPageDto {
  items: AuditLogDto[];
  nextCursor: string | null;
}

export interface AuditFacetsDto {
  actions: string[];
  entities: string[];
  actors: { id: string; name: string; email: string }[];
}

// ───────────────────────── Report export & schedules ─────────────────────────

export const REPORT_EXPORTS = [
  { key: "overview", label: "Sales overview (daily)" },
  { key: "payments", label: "Payment modes" },
  { key: "order-types", label: "Order types" },
  { key: "categories", label: "Categories" },
  { key: "top-items", label: "Top items" },
  { key: "tax", label: "GST summary" },
  { key: "day-end", label: "Day-end (Z) report" },
  { key: "fraud", label: "Fraud & pilferage watch" },
  { key: "cash-sessions", label: "Cash drawers" },
  { key: "outlets", label: "Outlet comparison" },
] as const;
export type ReportExportKey = (typeof REPORT_EXPORTS)[number]["key"];
export const REPORT_EXPORT_KEYS = REPORT_EXPORTS.map((r) => r.key) as unknown as [ReportExportKey, ...ReportExportKey[]];
export type ExportFormat = "csv" | "xlsx";

export const ReportScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    frequency: z.enum(["DAILY", "WEEKLY"]),
    weekday: z.number().int().min(0).max(6).nullable().optional(), // 0 = Sunday; WEEKLY only
    hour: z.number().int().min(0).max(23),
    recipients: z.array(z.string().trim().email()).min(1).max(20),
    reports: z.array(z.enum(REPORT_EXPORT_KEYS)).min(1),
    format: z.enum(["CSV", "XLSX"]).default("XLSX"),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.frequency === "DAILY" || v.weekday != null, { message: "Weekly schedules need a weekday", path: ["weekday"] });
export type ReportScheduleInput = z.infer<typeof ReportScheduleSchema>;

export interface ReportScheduleDto {
  id: string;
  outletId: string;
  name: string;
  frequency: "DAILY" | "WEEKLY";
  weekday: number | null;
  hour: number;
  recipients: string[];
  reports: ReportExportKey[];
  format: "CSV" | "XLSX";
  isActive: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

// ───────────────────────── API keys, webhooks ─────────────────────────

export const API_KEY_PREFIX = "stk_";

export const ApiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(PermissionKeySchema.refine((k) => k !== "*", "API keys cannot hold *")).min(1).max(50),
  outletIds: z.array(z.string().min(1)).max(100).nullable().optional(), // null/absent = all outlets
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});
export type ApiKeyCreateInput = z.infer<typeof ApiKeyCreateSchema>;

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  outletIds: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyCreatedDto extends ApiKeyDto {
  key: string; // shown once
}

export const WEBHOOK_EVENTS = [
  { key: "order.created", description: "A new order was opened (POS, scan & order, aggregator)." },
  { key: "order.settled", description: "An order was paid and closed." },
  { key: "order.cancelled", description: "An open order was voided." },
  { key: "kot.status", description: "A kitchen ticket moved to a new prep stage." },
  { key: "item.availability", description: "An item was 86'd or brought back in stock." },
  { key: "stock.low", description: "A raw material fell to or below its reorder level." },
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]["key"];
export const WEBHOOK_EVENT_KEYS = WEBHOOK_EVENTS.map((e) => e.key) as unknown as [WebhookEventType, ...WebhookEventType[]];

export const WebhookCreateSchema = z.object({
  url: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), "URL must be http(s)"),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_KEYS)).min(1),
  outletId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().default(true),
});
export type WebhookCreateInput = z.infer<typeof WebhookCreateSchema>;
export const WebhookUpdateSchema = z.object({
  url: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), "URL must be http(s)").optional(),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_KEYS)).min(1).optional(),
  outletId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type WebhookUpdateInput = z.infer<typeof WebhookUpdateSchema>;

export interface WebhookDto {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventType[];
  outletId: string | null;
  isActive: boolean;
  createdAt: string;
  secretPreview: string; // "whsec_abcd…"
}

export interface WebhookCreatedDto extends WebhookDto {
  secret: string; // shown once
}

export interface WebhookDeliveryDto {
  id: string;
  endpointId: string;
  eventType: string;
  eventId: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  durationMs: number | null;
  createdAt: string;
  deliveredAt: string | null;
  payload: unknown;
}

/** Webhook signature header value: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
export const WEBHOOK_SIGNATURE_HEADER = "stello-signature";
