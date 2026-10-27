import type {
  BillDto,
  ClaimPrintJobsInput,
  ClaimedPrintJobDto,
  CompletePrintJobInput,
  CreatePrinterInput,
  KotTicketDto,
  PrintJobDto,
  PrintRequestInput,
  PrintSettingsDto,
  PrinterDto,
  RecentBillDto,
  UpdatePrintSettingsInput,
  UpdatePrinterInput,
} from "@stello/shared";
import { request } from "./api";

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

// Printer setup, print jobs and reprints (see apps/api/src/printing).
export const printApi = {
  printers: (outletId: string) => request<PrinterDto[]>(`/outlets/${outletId}/printers`),
  createPrinter: (outletId: string, input: CreatePrinterInput) => post<PrinterDto>(`/outlets/${outletId}/printers`, input),
  updatePrinter: (outletId: string, id: string, input: UpdatePrinterInput) =>
    request<PrinterDto>(`/outlets/${outletId}/printers/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deletePrinter: (outletId: string, id: string) =>
    request<{ id: string }>(`/outlets/${outletId}/printers/${id}`, { method: "DELETE" }),
  testPrint: (outletId: string, id: string) => post<PrintJobDto>(`/outlets/${outletId}/printers/${id}/test`),

  settings: (outletId: string) => request<PrintSettingsDto>(`/outlets/${outletId}/print-settings`),
  updateSettings: (outletId: string, input: UpdatePrintSettingsInput) =>
    request<PrintSettingsDto>(`/outlets/${outletId}/print-settings`, { method: "PUT", body: JSON.stringify(input) }),

  previewBill: (outletId: string, orderId: string) => request<BillDto>(`/outlets/${outletId}/print/bills/${orderId}/preview`),
  previewKot: (outletId: string, kotId: string) => request<KotTicketDto[]>(`/outlets/${outletId}/print/kots/${kotId}/preview`),
  printBill: (outletId: string, orderId: string, input: PrintRequestInput = {}) =>
    post<PrintJobDto[]>(`/outlets/${outletId}/print/bills/${orderId}`, input),
  printKot: (outletId: string, kotId: string, input: PrintRequestInput = {}) =>
    post<PrintJobDto[]>(`/outlets/${outletId}/print/kots/${kotId}`, input),
  kickDrawer: (outletId: string, input: PrintRequestInput = {}) => post<PrintJobDto[]>(`/outlets/${outletId}/print/drawer`, input),
  recentBills: (outletId: string) => request<RecentBillDto[]>(`/outlets/${outletId}/print/recent-bills`),

  jobs: (outletId: string, status?: string) =>
    request<PrintJobDto[]>(`/outlets/${outletId}/print-jobs${status ? `?status=${status}` : ""}`),
  claim: (outletId: string, input: ClaimPrintJobsInput) => post<ClaimedPrintJobDto[]>(`/outlets/${outletId}/print-jobs/claim`, input),
  complete: (id: string, input: CompletePrintJobInput) => post<PrintJobDto>(`/print-jobs/${id}/complete`, input),
  retry: (id: string) => post<PrintJobDto>(`/print-jobs/${id}/retry`),
  cancel: (id: string) => post<PrintJobDto>(`/print-jobs/${id}/cancel`),
  reprint: (id: string) => post<PrintJobDto>(`/print-jobs/${id}/reprint`),
};
