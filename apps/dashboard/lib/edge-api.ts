import type { EdgeConflictDto, EdgeDeviceDto, EdgeSeriesRowDto, EdgeStaffPinRowDto } from "@stello/shared";
import { request } from "./api";

// Console endpoints for offline edge terminals (apps/api/src/edge).
export const edgeApi = {
  devices: (outletId: string) => request<EdgeDeviceDto[]>(`/outlets/${outletId}/edge/devices`),
  revokeDevice: (outletId: string, id: string) => request<{ id: string }>(`/outlets/${outletId}/edge/devices/${id}/revoke`, { method: "POST" }),
  staff: (outletId: string) => request<EdgeStaffPinRowDto[]>(`/outlets/${outletId}/edge/staff`),
  setPin: (outletId: string, userId: string, pin: string) =>
    request<{ userId: string }>(`/outlets/${outletId}/edge/staff/${userId}/pin`, { method: "PUT", body: JSON.stringify({ pin }) }),
  clearPin: (outletId: string, userId: string) => request<{ userId: string }>(`/outlets/${outletId}/edge/staff/${userId}/pin`, { method: "DELETE" }),
  conflicts: (outletId: string, status?: "OPEN" | "RESOLVED") =>
    request<EdgeConflictDto[]>(`/outlets/${outletId}/edge/conflicts${status ? `?status=${status}` : ""}`),
  resolve: (outletId: string, id: string, note: string) =>
    request<{ id: string }>(`/outlets/${outletId}/edge/conflicts/${id}/resolve`, { method: "POST", body: JSON.stringify({ note }) }),
  series: (outletId: string) => request<EdgeSeriesRowDto[]>(`/outlets/${outletId}/edge/series`),
};
