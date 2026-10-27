import type {
  ApiKeyCreateInput,
  ApiKeyCreatedDto,
  ApiKeyDto,
  AuditFacetsDto,
  AuditLogDto,
  AuditPageDto,
  CookieSessionResponse,
  CustomReportInput,
  ExportFormat,
  MfaEnabledDto,
  MfaSetupDto,
  MfaStatusDto,
  PermissionDef,
  ReportScheduleDto,
  ReportScheduleInput,
  RoleDetailDto,
  RoleInput,
  SecuritySettingsDto,
  StaffAccountDto,
  WebhookCreateInput,
  WebhookCreatedDto,
  WebhookDeliveryDto,
  WebhookDto,
  WebhookUpdateInput,
} from "@stello/shared";
import { apiFetch, request } from "./api";

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Download a server-generated file (streamed by the API) and hand it to the browser. */
async function download(path: string, init: RequestInit = {}): Promise<void> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let message = `Export failed (${res.status})`;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const platformApi = {
  // 2FA — login step-up (no session yet)
  mfaChallenge: (mfaToken: string, input: { code?: string; recoveryCode?: string }) =>
    request<CookieSessionResponse>("/auth/mfa/challenge", json("POST", { mfaToken, ...input })),
  mfaEnrollStart: (mfaToken: string) => request<MfaSetupDto>("/auth/mfa/enroll/start", json("POST", { mfaToken })),
  mfaEnrollConfirm: (mfaToken: string, code: string) =>
    request<CookieSessionResponse & { recoveryCodes: string[] }>("/auth/mfa/enroll/confirm", json("POST", { mfaToken, code })),

  // 2FA — signed-in self service
  mfaStatus: () => request<MfaStatusDto>("/auth/mfa"),
  mfaSetup: () => request<MfaSetupDto>("/auth/mfa/setup", json("POST")),
  mfaEnable: (code: string) => request<MfaEnabledDto>("/auth/mfa/enable", json("POST", { code })),
  mfaDisable: (password: string, code?: string) => request<{ status: string }>("/auth/mfa/disable", json("POST", { password, code })),
  mfaRecoveryCodes: (password: string, code?: string) => request<MfaEnabledDto>("/auth/mfa/recovery-codes", json("POST", { password, code })),
  logoutAll: () => request<{ status: string }>("/auth/logout-all", json("POST")),
  securitySettings: () => request<SecuritySettingsDto>("/security/settings"),
  setSecuritySettings: (input: SecuritySettingsDto) => request<SecuritySettingsDto>("/security/settings", json("PUT", input)),

  // Roles & staff
  permissions: () => request<PermissionDef[]>("/permissions"),
  roles: () => request<RoleDetailDto[]>("/roles"),
  createRole: (input: RoleInput) => request<RoleDetailDto>("/roles", json("POST", input)),
  updateRole: (id: string, input: RoleInput) => request<RoleDetailDto>(`/roles/${id}`, json("PATCH", input)),
  deleteRole: (id: string) => request<{ id: string }>(`/roles/${id}`, json("DELETE")),
  staff: () => request<StaffAccountDto[]>("/staff"),
  assignRole: (userId: string, roleId: string) => request<StaffAccountDto>(`/staff/${userId}/role`, json("PATCH", { roleId })),

  // Audit log
  auditPage: (q: { cursor?: string; limit?: number; actorId?: string; action?: string; entity?: string; entityId?: string; from?: string; to?: string }) =>
    request<AuditPageDto>(`/audit-logs${qs(q)}`),
  auditEntry: (id: string) => request<AuditLogDto>(`/audit-logs/${id}`),
  auditFacets: () => request<AuditFacetsDto>("/audit-logs/facets"),

  // Report export & schedules
  exportReport: (outletId: string, report: string, format: ExportFormat, from: string, to: string) =>
    download(`/outlets/${outletId}/reports/export${qs({ report, format, from, to })}`),
  exportCustom: (outletId: string, input: CustomReportInput, format: ExportFormat) =>
    download(`/outlets/${outletId}/reports/export/custom${qs({ format })}`, json("POST", input)),
  schedules: (outletId: string) => request<ReportScheduleDto[]>(`/outlets/${outletId}/report-schedules`),
  createSchedule: (outletId: string, input: ReportScheduleInput) =>
    request<ReportScheduleDto>(`/outlets/${outletId}/report-schedules`, json("POST", input)),
  updateSchedule: (outletId: string, id: string, input: ReportScheduleInput) =>
    request<ReportScheduleDto>(`/outlets/${outletId}/report-schedules/${id}`, json("PATCH", input)),
  deleteSchedule: (outletId: string, id: string) => request<{ id: string }>(`/outlets/${outletId}/report-schedules/${id}`, json("DELETE")),
  sendScheduleNow: (outletId: string, id: string) =>
    request<ReportScheduleDto>(`/outlets/${outletId}/report-schedules/${id}/send-now`, json("POST")),

  // API keys & webhooks
  apiKeys: () => request<ApiKeyDto[]>("/integrations/api-keys"),
  createApiKey: (input: ApiKeyCreateInput) => request<ApiKeyCreatedDto>("/integrations/api-keys", json("POST", input)),
  revokeApiKey: (id: string) => request<ApiKeyDto>(`/integrations/api-keys/${id}`, json("DELETE")),
  webhooks: () => request<WebhookDto[]>("/integrations/webhooks"),
  createWebhook: (input: WebhookCreateInput) => request<WebhookCreatedDto>("/integrations/webhooks", json("POST", input)),
  updateWebhook: (id: string, input: WebhookUpdateInput) => request<WebhookDto>(`/integrations/webhooks/${id}`, json("PATCH", input)),
  deleteWebhook: (id: string) => request<{ id: string }>(`/integrations/webhooks/${id}`, json("DELETE")),
  rotateWebhookSecret: (id: string) => request<WebhookCreatedDto>(`/integrations/webhooks/${id}/rotate-secret`, json("POST")),
  testWebhook: (id: string) => request<WebhookDeliveryDto>(`/integrations/webhooks/${id}/test`, json("POST")),
  webhookDeliveries: (id: string, cursor?: string) =>
    request<{ items: WebhookDeliveryDto[]; nextCursor: string | null }>(`/integrations/webhooks/${id}/deliveries${qs({ cursor })}`),
  redeliver: (deliveryId: string) =>
    request<WebhookDeliveryDto>(`/integrations/webhooks/deliveries/${deliveryId}/redeliver`, json("POST")),
};
