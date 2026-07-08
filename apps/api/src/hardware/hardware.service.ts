import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser, CallerIdDto, ScaleReadingDto } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { HARDWARE_BRIDGE, type HardwareBridge } from "./hardware.bridge";

@Injectable()
export class HardwareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @Inject(HARDWARE_BRIDGE) private readonly bridge: HardwareBridge,
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

  /** Wireless calling device: a diner at a table pages a waiter. */
  async callWaiter(tableToken: string): Promise<{ tableName: string }> {
    const table = await this.prisma.diningTable.findUnique({ where: { publicToken: tableToken } });
    if (!table) throw new NotFoundException("This QR code is no longer active");
    await this.prisma.auditLog.create({
      data: {
        tenantId: table.tenantId,
        action: "WAITER_CALLED",
        entity: "dining_table",
        entityId: table.id,
        data: { tableName: table.name },
      },
    });
    this.realtime.notifyOutlet(table.outletId);
    return { tableName: table.name };
  }
}
