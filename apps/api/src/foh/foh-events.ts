import { Injectable } from "@nestjs/common";
import type { ServerCallDto } from "@stello/shared";
import { RealtimeGateway } from "../realtime/realtime.gateway";

/**
 * Front-of-house realtime signals, broadcast into the existing per-outlet
 * Socket.IO room (`outlet:<id>`) that POS/KDS/captain clients already join.
 *  - `foh:changed`  — floor/reservation/waitlist state moved; clients refetch.
 *  - `foh:call`     — a server call was raised or changed (payload included so
 *                     screens can toast + chime without a round trip).
 */
@Injectable()
export class FohEvents {
  constructor(private readonly realtime: RealtimeGateway) {}

  changed(outletId: string) {
    this.realtime.server?.to(`outlet:${outletId}`).emit("foh:changed", { outletId });
  }

  call(outletId: string, call: ServerCallDto) {
    this.realtime.server?.to(`outlet:${outletId}`).emit("foh:call", { outletId, call });
    this.changed(outletId);
  }
}
