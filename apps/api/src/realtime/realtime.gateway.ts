import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { JwtService } from "@nestjs/jwt";
import type { Server, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Cloud real-time layer for the KDS and dashboards. Clients join a room per
 * outlet; the API pushes a lightweight `kds:changed` signal on any change and
 * the client refetches. Kept intentionally thin — no payload/ordering coupling.
 *
 * The offline LAN transport (the ~2s in-kitchen path) arrives with the edge
 * client; this gateway is the online path.
 *
 * Auth: the socket handshake must carry a valid user JWT (`auth.token`). The
 * connection is rejected otherwise, and a client may only join outlet rooms
 * within its own tenant — without this any client could subscribe to any
 * outlet's ticket stream (a cross-tenant leak).
 */
@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ??
      (process.env.NODE_ENV === "production" ? ["https://kitchens.stellotechs.com"] : true),
    credentials: true,
  },
  transports: ["websocket", "polling"],
})
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error("missing token");
      const payload = await this.jwt.verifyAsync<{ sub: string; tenantId: string; tokenVersion?: number }>(token);
      const user = await this.prisma.user.findFirst({ where: { id: payload.sub, tenantId: payload.tenantId, isActive: true }, select: { id: true, tenantId: true, tokenVersion: true, tenant: { select: { status: true } } } });
      if (!user || user.tenant.status === "SUSPENDED" || payload.tokenVersion !== user.tokenVersion) throw new Error("inactive user or tenant");
      client.data.tenantId = payload.tenantId;
      client.data.userId = payload.sub;
      client.data.tokenVersion = payload.tokenVersion;
    } catch {
      // Invalid/missing token — refuse the connection outright.
      client.disconnect(true);
    }
  }

  @SubscribeMessage("join")
  async join(@MessageBody() body: { outletId: string }, @ConnectedSocket() client: Socket) {
    const tenantId = client.data?.tenantId as string | undefined;
    if (!tenantId || !body?.outletId) return { joined: null };

    // Only allow joining a room for an outlet in the caller's own tenant.
    const outlet = await this.prisma.outlet.findFirst({
      where: { id: body.outletId, tenantId },
      select: { id: true },
    });
    if (!outlet) return { joined: null };
    const assigned = await this.prisma.userOutlet.findFirst({ where: { userId: client.data.userId, outletId: body.outletId } });
    if (!assigned) return { joined: null };

    // Leave any previously-joined outlet rooms, then join the requested one.
    for (const room of client.rooms) {
      if (room.startsWith("outlet:")) client.leave(room);
    }
    client.join(`outlet:${body.outletId}`);
    return { joined: body.outletId };
  }

  /** Signal that KDS-relevant state changed for an outlet (new KOT, bump, 86). */
  notifyOutlet(outletId: string) {
    this.server?.to(`outlet:${outletId}`).emit("kds:changed", { outletId });
  }
}
