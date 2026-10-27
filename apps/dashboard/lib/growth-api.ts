import type {
  BrandSummaryDto,
  CreateChainOutletInput,
  MasterAddonGroupInput,
  MasterCategoryInput,
  MasterComboInput,
  MasterItemInput,
  MasterMenuDto,
  MasterOverrideDto,
  MasterOverrideInput,
  PlanDto,
  PlatformSubscriptionActionInput,
  PlatformSubscriptionRowDto,
  PreferencesDto,
  PublishPlanDto,
  SubscribeInput,
  SubscriptionDto,
  SubscriptionInvoiceDto,
  UpdateMasterItemInput,
  UpdatePlanInput,
} from "@stello/shared";
import { request } from "./api";

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
const del: RequestInit = { method: "DELETE" };

// Brand master menu, SaaS billing and user preferences (kept out of lib/api.ts
// so this track's client calls live in one place).
export const growthApi = {
  // Brand master menu
  brands: () => request<BrandSummaryDto[]>("/chain/brands"),
  masterMenu: (brandId: string) => request<MasterMenuDto>(`/chain/brands/${brandId}/menu`),
  importMaster: (brandId: string, outletId: string) =>
    request<{ categories: number; items: number; addonGroups: number }>(`/chain/brands/${brandId}/import`, post({ outletId })),
  createMasterCategory: (brandId: string, body: MasterCategoryInput) =>
    request<{ id: string }>(`/chain/brands/${brandId}/categories`, post(body)),
  updateMasterCategory: (brandId: string, id: string, body: Partial<MasterCategoryInput>) =>
    request<{ id: string }>(`/chain/brands/${brandId}/categories/${id}`, patch(body)),
  deleteMasterCategory: (brandId: string, id: string) => request<{ id: string }>(`/chain/brands/${brandId}/categories/${id}`, del),
  createMasterItem: (brandId: string, body: MasterItemInput) => request<{ id: string }>(`/chain/brands/${brandId}/items`, post(body)),
  updateMasterItem: (brandId: string, id: string, body: UpdateMasterItemInput) =>
    request<{ id: string }>(`/chain/brands/${brandId}/items/${id}`, patch(body)),
  deleteMasterItem: (brandId: string, id: string) => request<{ id: string }>(`/chain/brands/${brandId}/items/${id}`, del),
  createMasterAddonGroup: (brandId: string, body: MasterAddonGroupInput) =>
    request<{ id: string }>(`/chain/brands/${brandId}/addon-groups`, post(body)),
  updateMasterAddonGroup: (brandId: string, id: string, body: MasterAddonGroupInput) =>
    request<{ id: string }>(`/chain/brands/${brandId}/addon-groups/${id}`, patch(body)),
  deleteMasterAddonGroup: (brandId: string, id: string) =>
    request<{ id: string }>(`/chain/brands/${brandId}/addon-groups/${id}`, del),
  createMasterCombo: (brandId: string, body: MasterComboInput) => request<{ id: string }>(`/chain/brands/${brandId}/combos`, post(body)),
  deleteMasterCombo: (brandId: string, id: string) => request<{ id: string }>(`/chain/brands/${brandId}/combos/${id}`, del),
  previewPublish: (brandId: string, outletIds: string[]) =>
    request<PublishPlanDto>(`/chain/brands/${brandId}/publish/preview`, post({ outletIds })),
  publish: (brandId: string, outletIds: string[]) => request<PublishPlanDto>(`/chain/brands/${brandId}/publish`, post({ outletIds })),
  createChainOutlet: (brandId: string, body: CreateChainOutletInput) =>
    request<{ id: string; name: string; published: boolean }>(`/chain/brands/${brandId}/outlets`, post(body)),
  overrides: (outletId: string) => request<MasterOverrideDto[]>(`/outlets/${outletId}/master-overrides`),
  setOverride: (outletId: string, masterItemId: string, body: MasterOverrideInput) =>
    request<{ masterItemId: string; cleared: boolean }>(`/outlets/${outletId}/master-overrides/${masterItemId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // Stello subscription (tenant)
  subscription: () => request<SubscriptionDto>("/subscription"),
  subscribe: (body: SubscribeInput) => request<SubscriptionDto>("/subscription/subscribe", post(body)),
  cancelSubscription: () => request<SubscriptionDto>("/subscription/cancel", post({})),
  payInvoice: (id: string) => request<SubscriptionDto>(`/subscription/invoices/${id}/pay`, post({})),
  invoice: (id: string) =>
    request<SubscriptionInvoiceDto & { tenantName: string; providerRef: string | null }>(`/subscription/invoices/${id}`),

  // Platform admin
  platformSubscriptions: () => request<PlatformSubscriptionRowDto[]>("/platform/subscriptions"),
  platformAction: (tenantId: string, body: PlatformSubscriptionActionInput) =>
    request<{ ok: boolean }>(`/platform/subscriptions/${tenantId}/action`, post(body)),
  platformRunCycle: () => request<Record<string, number>>("/platform/subscriptions/run-cycle", post({})),
  platformPlans: () => request<PlanDto[]>("/platform/plans"),
  platformUpdatePlan: (code: string, body: UpdatePlanInput) => request<PlanDto>(`/platform/plans/${code}`, patch(body)),

  // Preferences
  preferences: () => request<PreferencesDto>("/me/preferences"),
  setPreferences: (locale: string) => request<PreferencesDto>("/me/preferences", { method: "PUT", body: JSON.stringify({ locale }) }),
};
