import type {
  CfdSessionDto,
  CfdState,
  FloorViewDto,
  ReservationDto,
  ReservationInput,
  ReservationStatus,
  SaveFloorPlanInput,
  ServerCallDto,
  ServerCallType,
  UpdateReservationInput,
  WaiterAssignmentInput,
  WaiterSectionDto,
  WaitlistEntryDto,
  WaitlistInput,
} from "@stello/shared";
import { apiFetch, request } from "./api";

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Front-of-house endpoints: floor, reservations, waitlist, server calls, CFD, menu photos.
export const fohApi = {
  floor: (outletId: string) => request<FloorViewDto>(`/outlets/${outletId}/floor`),
  savePlan: (outletId: string, areaId: string, input: SaveFloorPlanInput) =>
    request<FloorViewDto>(`/outlets/${outletId}/floor/areas/${areaId}/plan`, json("PUT", input)),
  requestBill: (outletId: string, tableId: string) =>
    request<{ orderId: string; call: ServerCallDto }>(`/outlets/${outletId}/floor/tables/${tableId}/request-bill`, json("POST")),
  waiters: (outletId: string) => request<WaiterSectionDto[]>(`/outlets/${outletId}/floor/waiters`),
  assignWaiter: (outletId: string, input: WaiterAssignmentInput) =>
    request<WaiterSectionDto[]>(`/outlets/${outletId}/floor/waiters`, json("PUT", input)),

  reservations: (outletId: string, from: string, to: string) =>
    request<ReservationDto[]>(`/outlets/${outletId}/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  createReservation: (outletId: string, input: ReservationInput) =>
    request<ReservationDto>(`/outlets/${outletId}/reservations`, json("POST", input)),
  updateReservation: (outletId: string, id: string, input: UpdateReservationInput) =>
    request<ReservationDto>(`/outlets/${outletId}/reservations/${id}`, json("PATCH", input)),
  reservationStatus: (outletId: string, id: string, status: ReservationStatus) =>
    request<ReservationDto>(`/outlets/${outletId}/reservations/${id}/status`, json("POST", { status })),
  seatReservation: (outletId: string, id: string, tableId?: string) =>
    request<{ tableId: string; reservation: ReservationDto }>(`/outlets/${outletId}/reservations/${id}/seat`, json("POST", { tableId })),

  waitlist: (outletId: string) => request<WaitlistEntryDto[]>(`/outlets/${outletId}/waitlist`),
  addWaitlist: (outletId: string, input: WaitlistInput) =>
    request<WaitlistEntryDto>(`/outlets/${outletId}/waitlist`, json("POST", input)),
  notifyWaitlist: (outletId: string, id: string) =>
    request<WaitlistEntryDto>(`/outlets/${outletId}/waitlist/${id}/notify`, json("POST")),
  seatWaitlist: (outletId: string, id: string, tableId: string) =>
    request<{ tableId: string; entry: WaitlistEntryDto }>(`/outlets/${outletId}/waitlist/${id}/seat`, json("POST", { tableId })),
  leaveWaitlist: (outletId: string, id: string) =>
    request<WaitlistEntryDto>(`/outlets/${outletId}/waitlist/${id}/leave`, json("POST")),

  calls: (outletId: string) => request<ServerCallDto[]>(`/outlets/${outletId}/server-calls`),
  raiseCall: (outletId: string, tableId: string, type: ServerCallType) =>
    request<ServerCallDto>(`/outlets/${outletId}/server-calls`, json("POST", { tableId, type })),
  ackCall: (outletId: string, id: string) =>
    request<ServerCallDto>(`/outlets/${outletId}/server-calls/${id}/acknowledge`, json("POST")),
  resolveCall: (outletId: string, id: string) =>
    request<ServerCallDto>(`/outlets/${outletId}/server-calls/${id}/resolve`, json("POST")),

  cfdPair: (outletId: string, code: string) => request<{ id: string }>(`/outlets/${outletId}/cfd/pair`, json("POST", { code })),
  cfdPush: (outletId: string, id: string, state: CfdState) =>
    request<{ ok: true }>(`/outlets/${outletId}/cfd/${id}/state`, json("PUT", state)),
  cfdUnpair: (outletId: string, id: string) => request<{ id: string }>(`/outlets/${outletId}/cfd/${id}`, json("DELETE")),
  cfdStart: () => request<{ token: string; pairingCode: string; expiresAt: string }>(`/public/cfd/sessions`, json("POST")),
  cfdSession: (token: string) => request<CfdSessionDto>(`/public/cfd/sessions/${encodeURIComponent(token)}`),

  /** Multipart upload — bypasses the JSON helper so the browser sets the boundary. */
  uploadItemImage: async (outletId: string, itemId: string, file: Blob, filename: string) => {
    const form = new FormData();
    form.append("file", file, filename);
    const res = await apiFetch(`/outlets/${outletId}/menu/items/${itemId}/image`, { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? `Upload failed (${res.status})`);
    return body as { id: string; imageUrl: string; width: number; height: number };
  },
  removeItemImage: (outletId: string, itemId: string) =>
    request<{ id: string; imageUrl: null }>(`/outlets/${outletId}/menu/items/${itemId}/image`, json("DELETE")),
};

/**
 * Downscale a photo in the browser before upload (keeps uploads small and fast
 * on restaurant Wi-Fi; the API still validates type, size and dimensions).
 */
export async function downscaleImage(file: File, maxSide = 1200): Promise<{ blob: Blob; name: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, name: file.name };
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 400 * 1024) return { blob: file, name: file.name };
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  return blob ? { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" } : { blob: file, name: file.name };
}
