import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  CreateDeviceInput,
  DeviceDto,
  DeviceType,
  OutletBackupDto,
  UpdateDeviceInput,
} from "@petpooja/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async list(user: AuthUser, outletId: string): Promise<DeviceDto[]> {
    this.assertOutlet(user, outletId);
    const devices = await this.prisma.terminal.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });
    return devices.map((d) => this.toDto(d));
  }

  async create(user: AuthUser, outletId: string, input: CreateDeviceInput): Promise<DeviceDto> {
    this.assertOutlet(user, outletId);
    const device = await this.prisma.terminal.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        name: input.name,
        type: input.type,
        config: this.defaultConfig(input.type),
      },
    });
    return this.toDto(device);
  }

  async update(user: AuthUser, id: string, input: UpdateDeviceInput): Promise<DeviceDto> {
    const device = await this.requireDevice(user, id);
    const updated = await this.prisma.terminal.update({
      where: { id: device.id },
      data: {
        name: input.name ?? undefined,
        type: input.type ?? undefined,
        isActive: input.isActive ?? undefined,
        config: input.config !== undefined ? (input.config as Prisma.InputJsonValue) : undefined,
      },
    });
    this.realtime.notifyOutlet(device.outletId);
    return this.toDto(updated);
  }

  async remove(user: AuthUser, id: string) {
    const device = await this.requireDevice(user, id);
    await this.prisma.terminal.delete({ where: { id: device.id } });
    return { id: device.id };
  }

  /** A device self-reports it's alive (drives the online/offline dot). */
  async heartbeat(deviceToken: string) {
    const device = await this.prisma.terminal.findUnique({ where: { deviceToken } });
    if (!device) throw new NotFoundException("Unknown device");
    await this.prisma.terminal.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    return { ok: true };
  }

  /** A downloadable JSON snapshot of the outlet's configuration. */
  async backup(user: AuthUser, outletId: string): Promise<OutletBackupDto> {
    this.assertOutlet(user, outletId);
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    const [categories, combos, devices, areas, materials] = await Promise.all([
      this.prisma.menuCategory.findMany({
        where: { tenantId: user.tenantId, outletId, deletedAt: null },
        orderBy: { sortOrder: "asc" },
        include: { items: { where: { deletedAt: null }, orderBy: { name: "asc" } } },
      }),
      this.prisma.combo.count({ where: { tenantId: user.tenantId, outletId, deletedAt: null } }),
      this.prisma.terminal.findMany({ where: { tenantId: user.tenantId, outletId } }),
      this.prisma.area.findMany({
        where: { tenantId: user.tenantId, outletId },
        include: { tables: { orderBy: { name: "asc" } } },
      }),
      this.prisma.rawMaterial.count({ where: { tenantId: user.tenantId, outletId, deletedAt: null } }),
    ]);
    const itemCount = categories.reduce((s, c) => s + c.items.length, 0);
    const tableCount = areas.reduce((s, a) => s + a.tables.length, 0);
    return {
      generatedAt: new Date().toISOString(),
      outlet: { id: outlet.id, name: outlet.name, gstin: outlet.gstin },
      counts: {
        categories: categories.length,
        items: itemCount,
        combos,
        tables: tableCount,
        devices: devices.length,
        materials,
      },
      devices: devices.map((d) => ({
        name: d.name,
        type: d.type as DeviceType,
        config: (d.config as Record<string, unknown>) ?? {},
      })),
      menu: categories.map((c) => ({
        category: c.name,
        items: c.items.map((i) => ({ name: i.name, price: Number(i.price) })),
      })),
      tables: areas.flatMap((a) => a.tables.map((t) => ({ area: a.name, name: t.name }))),
    };
  }

  // ---------- helpers ----------

  private async requireDevice(user: AuthUser, id: string) {
    const device = await this.prisma.terminal.findUnique({ where: { id } });
    if (!device || device.tenantId !== user.tenantId) throw new NotFoundException("Device not found");
    this.assertOutlet(user, device.outletId);
    return device;
  }

  private defaultConfig(type: DeviceType): Prisma.InputJsonValue {
    switch (type) {
      case "PRINTER":
        return { paperWidth: "80mm", autoPrintKot: true, autoPrintBill: true, copies: 1 };
      case "KDS":
        return { theme: "dark", density: "comfortable", sound: true, columns: 3 };
      default:
        return {};
    }
  }

  private toDto(d: {
    id: string;
    name: string;
    type: string;
    isActive: boolean;
    lastSeenAt: Date | null;
    deviceToken: string;
    config: Prisma.JsonValue;
  }): DeviceDto {
    return {
      id: d.id,
      name: d.name,
      type: d.type as DeviceType,
      isActive: d.isActive,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      deviceToken: d.deviceToken,
      config: (d.config as Record<string, unknown>) ?? {},
    };
  }
}
