import { Inject, Injectable } from "@nestjs/common";
import type { AuthUser, CallerIdDto, ScaleReadingDto } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { HARDWARE_BRIDGE, type HardwareBridge } from "./hardware.bridge";
import { ServerCallsService } from "../foh/server-calls.service";

@Injectable()
export class HardwareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @Inject(HARDWARE_BRIDGE) private readonly bridge: HardwareBridge,
    private readonly serverCalls: ServerCallsService,
  ) {}

  readScale(_user: AuthUser, _outletId: string): ScaleReadingDto {
    return this.bridge.readScale();
  }

  /** Simulate a caller-ID pop: read the ringing number, resolve it to a customer. */
  async callerId(user: AuthUser, outletId: string): Promise<CallerIdDto> {
    const phone = this.bridge.incomingCall() ?? "";
    const customer = phone
      ? await this.prisma.customer.findUnique({
          where: { outletId_phone: { outletId, phone } },
        })
      : null;
    return {
      phone,
      customerName: customer?.name ?? null,
      lastVisitAt: customer?.lastVisitAt?.toISOString() ?? null,
      totalOrders: customer?.totalOrders ?? 0,
    };
  }

  /**
   * Wireless calling device: a diner at a table pages a waiter. Recorded as a
   * front-of-house server call (audited, de-duplicated, pushed live to staff).
   */
  async callWaiter(tableToken: string): Promise<{ tableName: string }> {
    const { tableName } = await this.serverCalls.callFromTable(tableToken, "WAITER");
    return { tableName };
  }
}
