import type {
  AggregatorSyncLogDto,
  CampaignStatsDto,
  EInvoiceProfileDto,
  EInvoiceProfileInput,
  GatewayPaymentDto,
  InvoiceDto,
  LowStockAlertDto,
  MessagingConfigDto,
  MessagingConfigInput,
  OptOutDto,
  OptOutInput,
  OutboxMessageDto,
  TestMessageInput,
  UnresolvedRefundDto,
} from "@stello/shared";
import { request } from "./api";

const post = (body?: unknown): RequestInit => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/** Real-provider integrations: Razorpay collection, messaging, GSP, low stock, aggregator sync. */
export const integrationsApi = {
  // Razorpay collection (POS)
  collect: (outletId: string, orderId: string, amount: number) =>
    request<GatewayPaymentDto>(`/outlets/${outletId}/payments/${orderId}/collect`, post({ amount })),
  collection: (outletId: string, id: string) => request<GatewayPaymentDto>(`/outlets/${outletId}/payment-collections/${id}`),
  cancelCollection: (outletId: string, id: string) =>
    request<GatewayPaymentDto>(`/outlets/${outletId}/payment-collections/${id}/cancel`, post()),
  simulatePaid: (outletId: string, id: string) =>
    request<GatewayPaymentDto>(`/outlets/${outletId}/payment-collections/${id}/simulate-paid`, post()),
  unresolvedRefunds: (outletId: string) => request<UnresolvedRefundDto[]>(`/outlets/${outletId}/refunds/unresolved`),
  reconcileRefund: (outletId: string, id: string) =>
    request<{ id: string; status: string }>(`/outlets/${outletId}/refunds/${id}/reconcile`, post()),

  // Messaging
  messagingConfig: () => request<MessagingConfigDto>("/messaging/config"),
  saveMessagingConfig: (input: MessagingConfigInput) =>
    request<MessagingConfigDto>("/messaging/config", { method: "PUT", body: JSON.stringify(input) }),
  testMessage: (input: TestMessageInput) => request<{ id: string; status: string; provider: string | null }>("/messaging/test", post(input)),
  optOuts: () => request<OptOutDto[]>("/messaging/opt-outs"),
  addOptOut: (input: OptOutInput) => request<{ id: string }>("/messaging/opt-outs", post(input)),
  removeOptOut: (id: string) => request<{ id: string }>(`/messaging/opt-outs/${id}`, { method: "DELETE" }),
  outbox: (campaignId?: string) =>
    request<OutboxMessageDto[]>(`/messaging/outbox${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  campaignStats: (id: string) => request<CampaignStatsDto>(`/messaging/campaigns/${id}/stats`),

  // GST e-invoicing
  einvoiceProfile: (outletId: string) => request<EInvoiceProfileDto>(`/outlets/${outletId}/einvoice-profile`),
  saveEinvoiceProfile: (outletId: string, input: EInvoiceProfileInput) =>
    request<EInvoiceProfileDto>(`/outlets/${outletId}/einvoice-profile`, { method: "PUT", body: JSON.stringify(input) }),
  cancelIrn: (outletId: string, orderId: string, reason: string, reasonCode: "1" | "2" | "3" | "4") =>
    request<InvoiceDto>(`/outlets/${outletId}/invoices/${orderId}/cancel-irn`, post({ reason, reasonCode })),

  // Low stock
  lowStockAlerts: (outletId: string) => request<LowStockAlertDto[]>(`/outlets/${outletId}/low-stock/alerts`),
  ackLowStock: (outletId: string, id: string) => request<{ id: string }>(`/outlets/${outletId}/low-stock/alerts/${id}/ack`, post()),
  checkLowStock: (outletId: string) => request<{ raised: number }>(`/outlets/${outletId}/low-stock/check`, post()),

  // Aggregator sync
  pushMenu: (outletId: string, platform: string) => request<unknown>(`/outlets/${outletId}/aggregator-sync/menu`, post({ platform })),
  pushStock: (outletId: string, platform: string) => request<unknown>(`/outlets/${outletId}/aggregator-sync/stock`, post({ platform })),
  setStore: (outletId: string, platform: string, online: boolean, reason?: string) =>
    request<unknown>(`/outlets/${outletId}/aggregator-sync/store`, post({ platform, online, reason })),
  aggregatorOrderStatus: (outletId: string, id: string, status: string, prepTimeMins?: number) =>
    request<{ id: string; status: string; simulated: boolean }>(`/outlets/${outletId}/aggregator-sync/orders/${id}/status`, post({ status, prepTimeMins })),
  syncLog: (outletId: string) => request<AggregatorSyncLogDto[]>(`/outlets/${outletId}/aggregator-sync/log`),
};
