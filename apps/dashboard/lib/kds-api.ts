import type {
  AdvanceTicketInput,
  KdsStockItemDto,
  KdsTicketDto,
  StationDto,
} from "@stello/shared";
import { request } from "./api";

// KDS-specific endpoints, mirroring apps/kds/src/api.ts's `api` object.
// Token/session handling (setToken/hasToken/login/me/outlets) is already
// owned by the shared client in ./api — this only adds the board methods.
export const kdsApi = {
  stations: (outletId: string) => request<StationDto[]>(`/outlets/${outletId}/kds/stations`),
  tickets: (outletId: string) => request<KdsTicketDto[]>(`/outlets/${outletId}/kds/tickets`),
  stock: (outletId: string) => request<KdsStockItemDto[]>(`/outlets/${outletId}/kds/stock`),
  advance: (kotId: string, input: AdvanceTicketInput) =>
    request<{ ok: true }>(`/kds/kots/${kotId}/advance`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  toggleStock: (outletId: string, itemId: string, inStock: boolean) =>
    request<{ id: string; inStock: boolean }>(`/outlets/${outletId}/menu/items/${itemId}/stock`, {
      method: "PATCH",
      body: JSON.stringify({ inStock }),
    }),
};
