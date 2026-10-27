import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import type { CfdSessionDto } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";

/**
 * Push channel for customer-facing displays, on its own `/cfd` namespace so it
 * never shares rooms with the staff (JWT) namespace. A display authenticates
 * with its secret session token and only ever joins its own `cfd:<id>` room.
 */
@WebSocketGateway({
  namespace: "cfd",
  cors: {
    origin: process.env.CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ??
      (process.env.NODE_ENV === "production" ? ["https://kitchens.stellotechs.com"] : true),
    credentials: true,
  },
  transports: ["websocket", "polling"],
})
export class CfdGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly prisma: PrismaService) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    const session = token
      ? await runUnscoped(() => this.prisma.cfdSession.findUnique({ where: { token }, select: { id: true, expiresAt: true } }))
      : null;
    if (!session || session.expiresAt < new Date()) {
      client.disconnect(true);
      return;
    }
    client.join(`cfd:${session.id}`);
  }

  emitState(id: string, dto: CfdSessionDto) {
    this.server?.to(`cfd:${id}`).emit("cfd:state", dto);
  }

  emitUnpaired(id: string) {
    this.server?.to(`cfd:${id}`).emit("cfd:unpaired", { id });
  }
}
