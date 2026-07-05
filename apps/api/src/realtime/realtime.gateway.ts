import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";

/**
 * Cloud real-time layer for the KDS and dashboards. Clients join a room per
 * outlet; the API pushes a lightweight `kds:changed` signal on any change and
 * the client refetches. Kept intentionally thin — no payload/ordering coupling.
 *
 * The offline LAN transport (the ~2s in-kitchen path) arrives with the edge
 * client; this gateway is the online path.
 */
@WebSocketGateway({ cors: { origin: true }, transports: ["websocket", "polling"] })
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  handleConnection() {
    // No-op: clients explicitly join their outlet room after connecting.
  }

  @SubscribeMessage("join")
  join(@MessageBody() body: { outletId: string }, @ConnectedSocket() client: Socket) {
    if (body?.outletId) {
      // Leave any previously-joined outlet rooms, then join the requested one.
      for (const room of client.rooms) {
        if (room.startsWith("outlet:")) client.leave(room);
      }
      client.join(`outlet:${body.outletId}`);
    }
    return { joined: body?.outletId ?? null };
  }

  /** Signal that KDS-relevant state changed for an outlet (new KOT, bump, 86). */
  notifyOutlet(outletId: string) {
    this.server?.to(`outlet:${outletId}`).emit("kds:changed", { outletId });
  }
}
