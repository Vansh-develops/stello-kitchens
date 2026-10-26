import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  FloorTableDto,
  FloorTableStatus,
  FloorViewDto,
  ReservationStatus,
  SaveFloorPlanInput,
  ServerCallType,
  TableShape,
  WaiterAssignmentInput,
  WaiterSectionDto,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { publicToken } from "../common/public-token";
import { FohEvents } from "./foh-events";
import { ServerCallsService } from "./server-calls.service";

/** A booked table shows as RESERVED this long before the guest is due. */
const RESERVED_LEAD_MS = 60 * 60_000;
/** ...and stays RESERVED this long past the booking time (late guests). */
const RESERVED_GRACE_MS = 30 * 60_000;

@Injectable()
export class FloorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: FohEvents,
    private readonly calls: ServerCallsService,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  /** Live floor: every area with its canvas, table placements and occupancy. */
  async view(user: AuthUser, outletId: string): Promise<FloorViewDto> {
    this.assertOutlet(user, outletId);
    const tenantId = user.tenantId;
    const now = new Date();
    const [areas, plans, openOrders, reservations, assignments, openCalls] = await Promise.all([
      this.prisma.area.findMany({
        where: { tenantId, outletId },
        include: { tables: { orderBy: { name: "asc" } } },
        orderBy: { name: "asc" },
      }),
      this.prisma.floorPlan.findMany({ where: { tenantId, outletId }, include: { placements: true } }),
      this.prisma.order.findMany({
        where: { tenantId, outletId, status: { in: ["OPEN", "BILLED"] }, tableId: { not: null } },
        select: { id: true, tableId: true, status: true, total: true, createdAt: true },
      }),
      this.prisma.reservation.findMany({
        where: {
          tenantId,
          outletId,
          status: { in: ["BOOKED", "CONFIRMED", "SEATED"] },
          startAt: { gte: new Date(now.getTime() - 8 * 3600_000), lte: new Date(now.getTime() + RESERVED_LEAD_MS) },
        },
        include: { tables: true },
        orderBy: { startAt: "asc" },
      }),
      this.prisma.waiterAssignment.findMany({ where: { tenantId, outletId } }),
      this.prisma.serverCall.findMany({
        where: { tenantId, outletId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        select: { tableId: true, type: true },
      }),
    ]);
    const billRequests = openOrders.length
      ? await this.prisma.billRequest.findMany({
          where: { tenantId, outletId, orderId: { in: openOrders.map((o) => o.id) } },
          select: { orderId: true },
        })
      : [];
    const billed = new Set(billRequests.map((b) => b.orderId));
    const orderByTable = new Map(openOrders.map((o) => [o.tableId as string, o]));

    // A seated party without a running order still occupies the table — until
    // an order for that table has come and gone after they were seated.
    const seated = reservations.filter((r) => r.status === "SEATED" && r.seatedAt);
    const seatedTableIds = seated.flatMap((r) => r.tables.map((t) => t.tableId));
    const laterOrders = seatedTableIds.length
      ? await this.prisma.order.findMany({
          where: {
            tenantId,
            outletId,
            tableId: { in: seatedTableIds },
            createdAt: { gte: new Date(Math.min(...seated.map((r) => r.seatedAt!.getTime()))) },
          },
          select: { tableId: true, createdAt: true },
        })
      : [];

    const userIds = [...new Set(assignments.map((a) => a.userId))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const placementByTable = new Map(plans.flatMap((p) => p.placements.map((pl) => [pl.tableId, pl] as const)));
    const planByArea = new Map(plans.map((p) => [p.areaId, p]));

    return {
      serverTime: now.toISOString(),
      areas: areas.map((area) => {
        const plan = planByArea.get(area.id);
        return {
          id: area.id,
          name: area.name,
          width: plan?.width ?? 1000,
          height: plan?.height ?? 700,
          tables: area.tables.map((t): FloorTableDto => {
            const pl = placementByTable.get(t.id);
            const order = orderByTable.get(t.id);
            const tableRes = reservations.filter((r) => r.tables.some((rt) => rt.tableId === t.id));
            const seatedRes = tableRes.find(
              (r) =>
                r.status === "SEATED" &&
                r.seatedAt &&
                !laterOrders.some((o) => o.tableId === t.id && o.createdAt >= r.seatedAt!) &&
                now.getTime() < r.seatedAt.getTime() + r.durationMinutes * 60_000,
            );
            const upcoming = tableRes.find(
              (r) =>
                r.status !== "SEATED" &&
                r.startAt.getTime() - RESERVED_LEAD_MS <= now.getTime() &&
                now.getTime() <= r.startAt.getTime() + RESERVED_GRACE_MS,
            );
            let status: FloorTableStatus = "FREE";
            let since: Date | null = null;
            if (order) {
              status = order.status === "BILLED" || billed.has(order.id) ? "BILL_PRINTED" : "OCCUPIED";
              since = order.createdAt;
            } else if (seatedRes) {
              status = "OCCUPIED";
              since = seatedRes.seatedAt;
            } else if (upcoming) {
              status = "RESERVED";
            }
            const shownRes = seatedRes ?? upcoming ?? null;
            const section = assignments.filter((a) => a.tableId === t.id || a.areaId === area.id);
            const waiterNames = section.map((a) => userName.get(a.userId)).filter((n): n is string => !!n);
            return {
              id: t.id,
              name: t.name,
              seats: t.seats,
              areaId: area.id,
              placement: pl
                ? { x: pl.x, y: pl.y, width: pl.width, height: pl.height, rotation: pl.rotation, shape: pl.shape as TableShape }
                : null,
              status,
              orderId: order?.id ?? null,
              orderTotal: order ? Number(order.total) : null,
              since: since?.toISOString() ?? null,
              reservation: shownRes
                ? {
                    id: shownRes.id,
                    guestName: shownRes.guestName,
                    partySize: shownRes.partySize,
                    startAt: shownRes.startAt.toISOString(),
                    status: shownRes.status as ReservationStatus,
                  }
                : null,
              waiterNames: [...new Set(waiterNames)],
              waiterIds: [...new Set(section.map((a) => a.userId))],
              openCalls: [...new Set(openCalls.filter((c) => c.tableId === t.id).map((c) => c.type as ServerCallType))],
            };
          }),
        };
      }),
    };
  }

  /**
   * Replace an area's floor plan. Existing tables (by id) must belong to this
   * area; entries without an id create new tables (with a fresh QR token).
   * Tables left out of the payload stay in the area but are no longer placed.
   */
  async savePlan(user: AuthUser, outletId: string, areaId: string, input: SaveFloorPlanInput) {
    this.assertOutlet(user, outletId);
    const tenantId = user.tenantId;
    await this.prisma.$transaction(async (tx) => {
      const area = await tx.area.findFirst({ where: { id: areaId, tenantId, outletId } });
      if (!area) throw new NotFoundException("Area not found");
      const areaTables = await tx.diningTable.findMany({ where: { tenantId, outletId, areaId } });
      const known = new Map(areaTables.map((t) => [t.id, t]));
      for (const t of input.tables) {
        if (t.tableId && !known.has(t.tableId)) throw new BadRequestException(`Table ${t.name} is not in this area`);
      }
      // Names must stay unique across the whole area, including unplaced tables.
      const placedIds = new Set(input.tables.map((t) => t.tableId).filter(Boolean));
      const taken = new Set(areaTables.filter((t) => !placedIds.has(t.id)).map((t) => t.name.trim().toLowerCase()));
      for (const t of input.tables) {
        if (taken.has(t.name.trim().toLowerCase())) throw new BadRequestException(`Table name ${t.name} is already used in this area`);
      }

      const plan = await tx.floorPlan.upsert({
        where: { areaId },
        create: { tenantId, outletId, areaId, width: input.width, height: input.height },
        update: { width: input.width, height: input.height },
      });
      await tx.tablePlacement.deleteMany({ where: { tenantId, floorPlanId: plan.id } });
      for (const t of input.tables) {
        let tableId = t.tableId;
        if (tableId) {
          await tx.diningTable.update({ where: { id: tableId }, data: { name: t.name, seats: t.seats } });
        } else {
          const created = await tx.diningTable.create({
            data: { tenantId, outletId, areaId, name: t.name, seats: t.seats, publicToken: publicToken() },
          });
          tableId = created.id;
        }
        await tx.tablePlacement.create({
          data: {
            tenantId,
            outletId,
            floorPlanId: plan.id,
            tableId,
            x: t.x,
            y: t.y,
            width: t.width,
            height: t.height,
            rotation: t.rotation,
            shape: t.shape,
          },
        });
      }
      await tx.auditLog.create({
        data: { tenantId, userId: user.id, action: "FLOOR_PLAN_SAVED", entity: "area", entityId: areaId, data: { tables: input.tables.length } },
      });
    });
    this.events.changed(outletId);
    return this.view(user, outletId);
  }

  /** Mark the running order's bill as requested/printed and alert the cashier. */
  async requestBill(user: AuthUser, outletId: string, tableId: string) {
    this.assertOutlet(user, outletId);
    const order = await this.prisma.order.findFirst({
      where: { tenantId: user.tenantId, outletId, tableId, status: { in: ["OPEN", "BILLED"] } },
    });
    if (!order) throw new BadRequestException("This table has no running order");
    await this.prisma.billRequest.upsert({
      where: { orderId: order.id },
      create: { tenantId: user.tenantId, outletId, orderId: order.id, tableId, requestedById: user.id },
      update: {},
    });
    const call = await this.calls.callByStaff(user, outletId, tableId, "BILL");
    this.events.changed(outletId);
    return { orderId: order.id, call };
  }

  // ---------- Waiter sections ----------

  async waiters(user: AuthUser, outletId: string): Promise<WaiterSectionDto[]> {
    this.assertOutlet(user, outletId);
    const [links, assignments] = await Promise.all([
      this.prisma.userOutlet.findMany({
        where: { outletId, user: { tenantId: user.tenantId, isActive: true } },
        include: { user: { include: { role: true } } },
      }),
      this.prisma.waiterAssignment.findMany({ where: { tenantId: user.tenantId, outletId } }),
    ]);
    return links
      .map((l) => l.user)
      .filter((u) => {
        const perms = Array.isArray(u.role.permissions) ? (u.role.permissions as string[]) : [];
        return perms.includes("captain.operate") || perms.includes("orders.create");
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((u) => ({
        userId: u.id,
        name: u.name,
        roleName: u.role.name,
        areaIds: assignments.filter((a) => a.userId === u.id && a.areaId).map((a) => a.areaId as string),
        tableIds: assignments.filter((a) => a.userId === u.id && a.tableId).map((a) => a.tableId as string),
      }));
  }

  async assignWaiter(user: AuthUser, outletId: string, input: WaiterAssignmentInput) {
    this.assertOutlet(user, outletId);
    const tenantId = user.tenantId;
    const member = await this.prisma.userOutlet.findFirst({
      where: { outletId, userId: input.userId, user: { tenantId } },
    });
    if (!member) throw new NotFoundException("Staff member not found in this outlet");
    const areaIds = [...new Set(input.areaIds)];
    const tableIds = [...new Set(input.tableIds)];
    const [areas, tables] = await Promise.all([
      this.prisma.area.count({ where: { tenantId, outletId, id: { in: areaIds } } }),
      this.prisma.diningTable.count({ where: { tenantId, outletId, id: { in: tableIds } } }),
    ]);
    if (areas !== areaIds.length || tables !== tableIds.length) throw new BadRequestException("Unknown area or table");
    await this.prisma.$transaction(async (tx) => {
      await tx.waiterAssignment.deleteMany({ where: { tenantId, outletId, userId: input.userId } });
      await tx.waiterAssignment.createMany({
        data: [
          ...areaIds.map((areaId) => ({ tenantId, outletId, userId: input.userId, areaId })),
          ...tableIds.map((tableId) => ({ tenantId, outletId, userId: input.userId, tableId })),
        ],
      });
    });
    this.events.changed(outletId);
    return this.waiters(user, outletId);
  }
}
