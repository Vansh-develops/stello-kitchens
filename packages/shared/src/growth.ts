import { z } from "zod";
import { LOCALE_CODES } from "./i18n";

// Track 8 — brand master menu (chains/franchises), Stello's own SaaS
// subscription billing, and per-user language preference.

// ---------- Brand master menu ----------

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const NameTranslations = z.record(z.string().regex(/^[a-z]{2}$/), z.string().max(120));

export const MasterCategorySchema = z.object({
  name: z.string().min(1).max(80),
  sortOrder: z.number().int().optional(),
  stationName: z.string().max(60).nullable().optional(),
});
export type MasterCategoryInput = z.infer<typeof MasterCategorySchema>;

export const MasterItemSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1).max(120),
  shortCode: z.string().max(12).nullable().optional(),
  price: z.number().nonnegative(),
  isVeg: z.boolean().default(true),
  taxRate: z.number().min(0).max(28).default(5),
  hsnCode: z.string().max(10).nullable().optional(),
  sortOrder: z.number().int().optional(),
  availableStart: HHMM.nullable().optional(),
  availableEnd: HHMM.nullable().optional(),
  variations: z.array(z.object({ name: z.string().min(1).max(60), price: z.number().nonnegative() })).default([]),
  addonGroupIds: z.array(z.string()).default([]),
  nameTranslations: NameTranslations.nullable().optional(),
});
export type MasterItemInput = z.infer<typeof MasterItemSchema>;
export const UpdateMasterItemSchema = MasterItemSchema.partial();
export type UpdateMasterItemInput = z.infer<typeof UpdateMasterItemSchema>;

export const MasterAddonGroupSchema = z.object({
  name: z.string().min(1).max(80),
  minSelect: z.number().int().min(0).default(0),
  maxSelect: z.number().int().min(1).default(1),
  addons: z.array(z.object({ name: z.string().min(1).max(60), price: z.number().nonnegative() })).min(1),
});
export type MasterAddonGroupInput = z.infer<typeof MasterAddonGroupSchema>;

export const MasterComboSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1).max(120),
  price: z.number().nonnegative(),
  isVeg: z.boolean().default(true),
  taxRate: z.number().min(0).max(28).default(5),
  hsnCode: z.string().max(10).nullable().optional(),
  sortOrder: z.number().int().optional(),
  slots: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        options: z
          .array(
            z.object({
              masterItemId: z.string().min(1),
              priceDelta: z.number().default(0),
              isDefault: z.boolean().default(false),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
export type MasterComboInput = z.infer<typeof MasterComboSchema>;

export const PublishMenuSchema = z.object({ outletIds: z.array(z.string().min(1)).min(1) });
export type PublishMenuInput = z.infer<typeof PublishMenuSchema>;

export const MasterOverrideSchema = z.object({
  price: z.number().nonnegative().nullable().default(null),
  inStock: z.boolean().nullable().default(null),
  isHidden: z.boolean().default(false),
});
export type MasterOverrideInput = z.infer<typeof MasterOverrideSchema>;

export const ImportMasterSchema = z.object({ outletId: z.string().min(1) });
export type ImportMasterInput = z.infer<typeof ImportMasterSchema>;

export const CreateChainOutletSchema = z.object({
  name: z.string().min(1).max(120),
  address: z.string().max(300).nullable().optional(),
  publishMenu: z.boolean().default(true),
});
export type CreateChainOutletInput = z.infer<typeof CreateChainOutletSchema>;

export interface MasterItemDto {
  id: string;
  categoryId: string;
  name: string;
  shortCode: string | null;
  price: number;
  isVeg: boolean;
  taxRate: number;
  hsnCode: string | null;
  sortOrder: number;
  availableStart: string | null;
  availableEnd: string | null;
  variations: { name: string; price: number }[];
  addonGroupIds: string[];
  nameTranslations: Record<string, string> | null;
  version: number;
}

export interface MasterCategoryDto {
  id: string;
  name: string;
  sortOrder: number;
  stationName: string | null;
  items: MasterItemDto[];
}

export interface MasterAddonGroupDto {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  addons: { name: string; price: number }[];
}

export interface MasterComboDto {
  id: string;
  categoryId: string;
  name: string;
  price: number;
  isVeg: boolean;
  taxRate: number;
  hsnCode: string | null;
  sortOrder: number;
  slots: { name: string; options: { masterItemId: string; priceDelta: number; isDefault: boolean }[] }[];
}

export type OutletSyncStatus = "NEVER" | "IN_SYNC" | "PENDING" | "FAILED";

export interface OutletSyncDto {
  outletId: string;
  outletName: string;
  publishedVersion: number;
  status: OutletSyncStatus;
  lastPublishedAt: string | null;
  lastError: string | null;
  overrideCount: number;
  outletOnlyItems: number;
}

export interface MasterMenuDto {
  brandId: string;
  brandName: string;
  version: number;
  categories: MasterCategoryDto[];
  addonGroups: MasterAddonGroupDto[];
  combos: MasterComboDto[];
  outlets: OutletSyncDto[];
}

export interface BrandSummaryDto {
  id: string;
  name: string;
  outletCount: number;
  version: number;
}

export type PublishEntity = "CATEGORY" | "ITEM" | "ADDON_GROUP" | "COMBO";
export type PublishAction = "CREATE" | "UPDATE" | "LINK" | "REMOVE" | "DETACH" | "UNCHANGED";

export interface PublishOpDto {
  entity: PublishEntity;
  action: PublishAction;
  masterId: string | null;
  outletRowId: string | null;
  name: string;
  changes: { field: string; from: unknown; to: unknown }[];
  // Set when the op overrides or preserves something an outlet changed locally.
  conflict: { rule: string; message: string } | null;
}

export interface OutletPublishPlanDto {
  outletId: string;
  outletName: string;
  ops: PublishOpDto[];
  counts: Record<PublishAction, number>;
  conflicts: number;
}

export interface PublishPlanDto {
  version: number;
  outlets: OutletPublishPlanDto[];
}

export interface MasterOverrideDto {
  masterItemId: string;
  name: string;
  categoryName: string;
  masterPrice: number;
  price: number | null;
  inStock: boolean | null;
  isHidden: boolean;
  effectivePrice: number;
}

// ---------- SaaS subscription billing ----------

export type SubscriptionStatus = "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELLED";
export type BillingCycle = "MONTHLY" | "YEARLY";
export type PlanResource = "outlets" | "terminals" | "users";
export type PlanFeature =
  | "pos"
  | "kds"
  | "scan_order"
  | "inventory"
  | "crm"
  | "loyalty"
  | "aggregators"
  | "central_kitchen"
  | "chain_menu"
  | "einvoice";

export type PlanLimits = Record<PlanResource, number | null>; // null = unlimited

export interface PlanDefinition {
  code: string;
  name: string;
  priceMonthly: number; // paise, excl. GST
  priceYearly: number; // paise, excl. GST
  limits: PlanLimits;
  features: PlanFeature[];
  sortOrder: number;
}

/** Default catalogue; seeded into the `plans` table and editable by platform admins. */
export const PLAN_CATALOGUE: PlanDefinition[] = [
  {
    code: "starter",
    name: "Starter",
    priceMonthly: 999_00,
    priceYearly: 9_990_00,
    limits: { outlets: 1, terminals: 2, users: 5 },
    features: ["pos", "kds", "scan_order"],
    sortOrder: 1,
  },
  {
    code: "growth",
    name: "Growth",
    priceMonthly: 2_499_00,
    priceYearly: 24_990_00,
    limits: { outlets: 3, terminals: 10, users: 25 },
    features: ["pos", "kds", "scan_order", "inventory", "crm", "loyalty", "aggregators", "einvoice"],
    sortOrder: 2,
  },
  {
    code: "chain",
    name: "Chain",
    priceMonthly: 7_999_00,
    priceYearly: 79_990_00,
    limits: { outlets: 25, terminals: 100, users: 250 },
    features: [
      "pos", "kds", "scan_order", "inventory", "crm", "loyalty", "aggregators", "einvoice",
      "central_kitchen", "chain_menu",
    ],
    sortOrder: 3,
  },
];

/** Plan a new tenant trials on. */
export const TRIAL_PLAN_CODE = "growth";
/** Days a PAST_DUE subscription keeps working before it is suspended. */
export const PAYMENT_GRACE_DAYS = 7;
/** GST on SaaS (SAC 998314), in basis points. */
export const SAAS_GST_BPS = 1800;

export type SubscriptionEvent =
  | "PAYMENT_SUCCEEDED"
  | "PAYMENT_FAILED"
  | "TRIAL_EXPIRED"
  | "GRACE_EXPIRED"
  | "CANCEL"
  | "PERIOD_ENDED"
  | "ADMIN_SUSPEND"
  | "ADMIN_REACTIVATE";

// Allowed lifecycle moves. CANCEL on an ACTIVE subscription only flags
// cancel-at-period-end (status stays ACTIVE until PERIOD_ENDED).
const TRANSITIONS: Record<SubscriptionStatus, Partial<Record<SubscriptionEvent, SubscriptionStatus>>> = {
  TRIAL: {
    PAYMENT_SUCCEEDED: "ACTIVE",
    TRIAL_EXPIRED: "SUSPENDED",
    CANCEL: "CANCELLED",
    ADMIN_SUSPEND: "SUSPENDED",
    ADMIN_REACTIVATE: "ACTIVE",
  },
  ACTIVE: {
    PAYMENT_SUCCEEDED: "ACTIVE",
    PAYMENT_FAILED: "PAST_DUE",
    CANCEL: "ACTIVE",
    PERIOD_ENDED: "CANCELLED",
    ADMIN_SUSPEND: "SUSPENDED",
  },
  PAST_DUE: {
    PAYMENT_SUCCEEDED: "ACTIVE",
    PAYMENT_FAILED: "PAST_DUE",
    GRACE_EXPIRED: "SUSPENDED",
    CANCEL: "CANCELLED",
    ADMIN_SUSPEND: "SUSPENDED",
    ADMIN_REACTIVATE: "ACTIVE",
  },
  SUSPENDED: {
    PAYMENT_SUCCEEDED: "ACTIVE",
    CANCEL: "CANCELLED",
    ADMIN_REACTIVATE: "ACTIVE",
  },
  CANCELLED: {
    PAYMENT_SUCCEEDED: "ACTIVE",
    ADMIN_REACTIVATE: "ACTIVE",
  },
};

export class InvalidSubscriptionTransition extends Error {
  constructor(readonly from: SubscriptionStatus, readonly event: SubscriptionEvent) {
    super(`Cannot apply ${event} to a ${from} subscription`);
  }
}

export function canTransition(from: SubscriptionStatus, event: SubscriptionEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

/** The status after `event`, or throws InvalidSubscriptionTransition. */
export function nextSubscriptionStatus(from: SubscriptionStatus, event: SubscriptionEvent): SubscriptionStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidSubscriptionTransition(from, event);
  return to;
}

/** Tenant.status mirror of a subscription status (login gating reads Tenant.status). */
export function tenantStatusFor(status: SubscriptionStatus): "TRIAL" | "ACTIVE" | "SUSPENDED" {
  if (status === "TRIAL") return "TRIAL";
  if (status === "ACTIVE" || status === "PAST_DUE") return "ACTIVE";
  return "SUSPENDED";
}

/** Resources whose current usage would exceed `limits` (for downgrade checks). */
export function limitBlockers(limits: PlanLimits, usage: Record<PlanResource, number>): PlanResource[] {
  return (Object.keys(limits) as PlanResource[]).filter((r) => limits[r] !== null && usage[r] > limits[r]!);
}

/** True when one more `resource` can be added under `limits`. */
export function withinLimit(limits: PlanLimits, usage: Record<PlanResource, number>, resource: PlanResource): boolean {
  const limit = limits[resource];
  return limit === null || limit === undefined || usage[resource] < limit;
}

/** Subtotal (paise) → { subtotal, taxAmount, total } with 18% GST, rounded to the paisa. */
export function saasInvoiceAmounts(subtotal: number): { subtotal: number; taxAmount: number; total: number } {
  const taxAmount = Math.round((subtotal * SAAS_GST_BPS) / 10_000);
  return { subtotal, taxAmount, total: subtotal + taxAmount };
}

export interface PlanDto extends PlanDefinition {
  isActive: boolean;
  providerPlanIds: { MONTHLY?: string; YEARLY?: string } | null;
}

export interface SubscriptionInvoiceDto {
  id: string;
  number: string;
  planCode: string;
  billingCycle: BillingCycle;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  status: "OPEN" | "PAID" | "FAILED" | "VOID";
  dueAt: string;
  paidAt: string | null;
}

export interface SubscriptionDto {
  status: SubscriptionStatus;
  plan: PlanDto;
  billingCycle: BillingCycle;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  provider: string;
  checkoutUrl: string | null;
  usage: Record<PlanResource, number>;
  invoices: SubscriptionInvoiceDto[];
  plans: PlanDto[];
}

export const SubscribeSchema = z.object({
  planCode: z.string().min(1),
  billingCycle: z.enum(["MONTHLY", "YEARLY"]).default("MONTHLY"),
});
export type SubscribeInput = z.infer<typeof SubscribeSchema>;

export interface PlatformSubscriptionRowDto {
  tenantId: string;
  tenantName: string;
  status: SubscriptionStatus;
  planCode: string;
  planName: string;
  billingCycle: BillingCycle;
  mrr: number; // paise, excl. GST
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  usage: Record<PlanResource, number>;
  limits: PlanLimits;
  openInvoices: number;
}

export const PlatformSubscriptionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("extend_trial"), days: z.number().int().min(1).max(90) }),
  z.object({ action: z.literal("suspend") }),
  z.object({ action: z.literal("reactivate") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("change_plan"), planCode: z.string().min(1) }),
]);
export type PlatformSubscriptionActionInput = z.infer<typeof PlatformSubscriptionActionSchema>;

const LimitValue = z.number().int().min(0).nullable();
export const UpdatePlanSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  priceMonthly: z.number().int().min(0).optional(),
  priceYearly: z.number().int().min(0).optional(),
  limits: z.object({ outlets: LimitValue, terminals: LimitValue, users: LimitValue }).optional(),
  features: z.array(z.string().min(1)).optional(),
  isActive: z.boolean().optional(),
  // Plan ids at the payment provider (Razorpay `plan_…`), per billing cycle.
  providerPlanIds: z.object({ MONTHLY: z.string().max(60).optional(), YEARLY: z.string().max(60).optional() }).optional(),
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanSchema>;

// ---------- Per-user preferences ----------

export const UpdatePreferencesSchema = z.object({
  locale: z.string().refine((v) => (LOCALE_CODES as readonly string[]).includes(v), "Unsupported language"),
});
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesSchema>;

export interface PreferencesDto {
  locale: string | null;
}
