import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  AuthUser,
  ReservationDto,
  ReservationInput,
  ReservationSource,
  ReservationStatus,
  UpdateReservationInput,
  WaitlistEntryDto,
  WaitlistInput,
  WaitlistStatus,
} from "@stello/shared";
import { BLOCKING_RESERVATION_STATUSES, RESERVATION_TRANSITIONS, intervalsOverlap } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NOTIFICATION_PROVIDER, type NotificationProvider } from "../crm/notification.provider";
import { FohEvents } from "./foh-events";

/** Longest booking we accept — bounds the conflict-scan window. */
const MAX_DURATION_MIN = 480;

const reservationInclude = { tables: true } satisfies Prisma.ReservationInclude;
type ReservationRow = Prisma.ReservationGetPayload<{ include: typeof reservationInclude }>;

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: FohEvents,
    @Inject(NOTIFICATION_PROVIDER) private readonly notifier: NotificationProvider,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  // ---------- Reservations ----------

  /** Reservations whose start falls in [from, to). */
  async list(user: AuthUser, outletId: string, from: Date, to: Date): Promise<ReservationDto[]> {
    this.assertOutlet(user, outletId);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw new BadRequestException("Invalid date range");
    }
    const rows = await this.prisma.reservation.findMany({
      where: { tenantId: user.tenantId, outletId, startAt: { gte: from, lt: to } },
      include: reservationInclude,
      orderBy: { startAt: "asc" },
    });
    return this.toDtos(user.tenantId, outletId, rows);
  }

  async create(user: AuthUser, outletId: string, input: ReservationInput): Promise<ReservationDto> {
    this.assertOutlet(user, outletId);
    const id = await this.prisma.$transaction(async (tx) => {
      const startAt = new Date(input.startAt);
      await this.lockAndCheck(tx, user.tenantId, outletId, input.tableIds, startAt, input.durationMinutes, null);
      const customer = await tx.customer.findFirst({ where: { tenantId: user.tenantId, outletId, phone: input.phone } });
      const r = await tx.reservation.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          guestName: input.guestName,
          phone: input.phone,
          partySize: input.partySize,
          startAt,
          durationMinutes: input.durationMinutes,
          notes: input.notes ?? null,
          source: input.source,
          customerId: customer?.id ?? null,
          createdById: user.id,
          tables: { create: [...new Set(input.tableIds)].map((tableId) => ({ tableId })) },
        },
      });
      await tx.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: "RESERVATION_CREATED", entity: "reservation", entityId: r.id },
      });
      return r.id;
    });
    this.events.changed(outletId);
    return this.getOne(user, outletId, id);
  }

  async update(user: AuthUser, outletId: string, id: string, input: UpdateReservationInput): Promise<ReservationDto> {
    this.assertOutlet(user, outletId);
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockReservation(tx, user.tenantId, outletId, id);
      if (!BLOCKING_RESERVATION_STATUSES.includes(current.status as ReservationStatus) || current.status === "SEATED") {
        throw new BadRequestException(`A ${current.status.toLowerCase().replace("_", "-")} reservation cannot be edited`);
      }
      const tableIds = input.tableIds ?? current.tables.map((t) => t.tableId);
      const startAt = input.startAt ? new Date(input.startAt) : current.startAt;
      const duration = input.durationMinutes ?? current.durationMinutes;
      await this.lockAndCheck(tx, user.tenantId, outletId, tableIds, startAt, duration, id);
      const phone = input.phone ?? current.phone;
      const customer = await tx.customer.findFirst({ where: { tenantId: user.tenantId, outletId, phone } });
      await tx.reservation.update({
        where: { id },
        data: {
          guestName: input.guestName,
          phone: input.phone,
          partySize: input.partySize,
          startAt,
          durationMinutes: duration,
          notes: input.notes,
          source: input.source,
          customerId: customer?.id ?? null,
        },
      });
      if (input.tableIds) {
        await tx.reservationTable.deleteMany({ where: { reservationId: id } });
        await tx.reservationTable.createMany({ data: [...new Set(tableIds)].map((tableId) => ({ reservationId: id, tableId })) });
      }
    });
    this.events.changed(outletId);
    return this.getOne(user, outletId, id);
  }

  /** Status moves other than seating (confirm, no-show, cancel, reinstate). */
  async setStatus(user: AuthUser, outletId: string, id: string, status: ReservationStatus): Promise<ReservationDto> {
    this.assertOutlet(user, outletId);
    if (status === "SEATED") throw new BadRequestException("Use seat to seat a reservation");
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockReservation(tx, user.tenantId, outletId, id);
      const from = current.status as ReservationStatus;
      if (!RESERVATION_TRANSITIONS[from].includes(status)) {
        throw new BadRequestException(`Cannot move a ${from.toLowerCase()} reservation to ${status.toLowerCase()}`);
      }
      // Reinstating re-claims the tables, so it must pass the conflict check again.
      if (status === "BOOKED" && !BLOCKING_RESERVATION_STATUSES.includes(from)) {
        await this.lockAndCheck(tx, user.tenantId, outletId, current.tables.map((t) => t.tableId), current.startAt, current.durationMinutes, id);
      }
      await tx.reservation.update({ where: { id }, data: { status } });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: `RESERVATION_${status}`,
          entity: "reservation",
          entityId: id,
          data: { from },
        },
      });
    });
    this.events.changed(outletId);
    return this.getOne(user, outletId, id);
  }

  /**
   * Seat the party: the reservation becomes SEATED on a (free) table and the
   * floor shows it occupied. The client then opens that table in the POS /
   * captain with the guest details prefilled.
   */
  async seat(user: AuthUser, outletId: string, id: string, tableId?: string) {
    this.assertOutlet(user, outletId);
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockReservation(tx, user.tenantId, outletId, id);
      if (current.status !== "BOOKED" && current.status !== "CONFIRMED") {
        throw new BadRequestException(`A ${current.status.toLowerCase()} reservation cannot be seated`);
      }
      const target = tableId ?? current.tables[0]?.tableId;
      if (!target) throw new BadRequestException("Pick a table to seat this party");
      await this.assertTableFree(tx, user.tenantId, outletId, target);
      if (!current.tables.some((t) => t.tableId === target)) {
        await tx.reservationTable.create({ data: { reservationId: id, tableId: target } });
      }
      await tx.reservation.update({ where: { id }, data: { status: "SEATED", seatedAt: new Date() } });
      await tx.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: "RESERVATION_SEATED", entity: "reservation", entityId: id, data: { tableId: target } },
      });
      return { tableId: target };
    });
    this.events.changed(outletId);
    return { ...result, reservation: await this.getOne(user, outletId, id) };
  }

  async getOne(user: AuthUser, outletId: string, id: string): Promise<ReservationDto> {
    const row = await this.prisma.reservation.findFirst({
      where: { id, tenantId: user.tenantId, outletId },
      include: reservationInclude,
    });
    if (!row) throw new NotFoundException("Reservation not found");
    return (await this.toDtos(user.tenantId, outletId, [row]))[0];
  }

  private async lockReservation(tx: Prisma.TransactionClient, tenantId: string, outletId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM reservations WHERE id = ${id} AND "tenantId" = ${tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException("Reservation not found");
    return tx.reservation.findFirstOrThrow({ where: { id, tenantId }, include: reservationInclude });
  }

  /**
   * Lock the requested tables (sorted, so concurrent bookings can't deadlock)
   * and reject the booking if any of them is held by an overlapping
   * BOOKED/CONFIRMED/SEATED reservation. Holding the table row locks until
   * commit serialises competing bookings for the same table.
   */
  private async lockAndCheck(
    tx: Prisma.TransactionClient,
    tenantId: string,
    outletId: string,
    tableIds: string[],
    startAt: Date,
    durationMinutes: number,
    excludeId: string | null,
  ) {
    const ids = [...new Set(tableIds)].sort();
    if (ids.length === 0) return;
    const locked = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM dining_tables
      WHERE id IN (${Prisma.join(ids)}) AND "tenantId" = ${tenantId} AND "outletId" = ${outletId}
      ORDER BY id FOR UPDATE`;
    if (locked.length !== ids.length) throw new BadRequestException("Table not found in this outlet");
    const names = new Map(locked.map((t) => [t.id, t.name]));

    const windowStart = new Date(startAt.getTime() - MAX_DURATION_MIN * 60_000);
    const windowEnd = new Date(startAt.getTime() + durationMinutes * 60_000);
    const candidates = await tx.reservation.findMany({
      where: {
        tenantId,
        outletId,
        status: { in: BLOCKING_RESERVATION_STATUSES },
        startAt: { gt: windowStart, lt: windowEnd },
        tables: { some: { tableId: { in: ids } } },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      include: reservationInclude,
    });
    const clash = candidates.find((r) =>
      intervalsOverlap(startAt.getTime(), durationMinutes, r.startAt.getTime(), r.durationMinutes),
    );
    if (clash) {
      const table = clash.tables.map((t) => names.get(t.tableId)).find(Boolean);
      const at = clash.startAt.toISOString();
      throw new ConflictException(`${table ?? "Table"} is already reserved for ${clash.guestName} (${at})`);
    }
  }

  private async assertTableFree(tx: Prisma.TransactionClient, tenantId: string, outletId: string, tableId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM dining_tables WHERE id = ${tableId} AND "tenantId" = ${tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
    if (!rows.length) throw new BadRequestException("Table not found in this outlet");
    const open = await tx.order.findFirst({ where: { tenantId, outletId, tableId, status: { in: ["OPEN", "BILLED"] } } });
    if (open) throw new ConflictException("That table still has a running order");
  }

  private async toDtos(tenantId: string, outletId: string, rows: ReservationRow[]): Promise<ReservationDto[]> {
    const tableIds = [...new Set(rows.flatMap((r) => r.tables.map((t) => t.tableId)))];
    const customerIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
    const [tables, customers] = await Promise.all([
      tableIds.length
        ? this.prisma.diningTable.findMany({ where: { tenantId, outletId, id: { in: tableIds } }, select: { id: true, name: true } })
        : [],
      customerIds.length
        ? this.prisma.customer.findMany({ where: { tenantId, outletId, id: { in: customerIds } } })
        : [],
    ]);
    const tableName = new Map(tables.map((t) => [t.id, t.name]));
    const customerMap = new Map(customers.map((c) => [c.id, c]));
    return rows.map((r) => {
      const c = r.customerId ? customerMap.get(r.customerId) : undefined;
      return {
        id: r.id,
        guestName: r.guestName,
        phone: r.phone,
        partySize: r.partySize,
        startAt: r.startAt.toISOString(),
        durationMinutes: r.durationMinutes,
        status: r.status as ReservationStatus,
        source: r.source as ReservationSource,
        notes: r.notes,
        tables: r.tables.map((t) => ({ id: t.tableId, name: tableName.get(t.tableId) ?? "?" })),
        customer: c
          ? { id: c.id, name: c.name, totalOrders: c.totalOrders, lastVisitAt: c.lastVisitAt?.toISOString() ?? null }
          : null,
        seatedAt: r.seatedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  // ---------- Waitlist ----------

  async waitlist(user: AuthUser, outletId: string): Promise<WaitlistEntryDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.waitlistEntry.findMany({
      where: {
        tenantId: user.tenantId,
        outletId,
        OR: [{ status: { in: ["WAITING", "NOTIFIED"] } }, { createdAt: { gte: new Date(Date.now() - 12 * 3600_000) } }],
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((w) => this.waitDto(w));
  }

  async addToWaitlist(user: AuthUser, outletId: string, input: WaitlistInput): Promise<WaitlistEntryDto> {
    this.assertOutlet(user, outletId);
    const customer = input.phone
      ? await this.prisma.customer.findFirst({ where: { tenantId: user.tenantId, outletId, phone: input.phone } })
      : null;
    const row = await this.prisma.waitlistEntry.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        guestName: input.guestName,
        phone: input.phone ?? null,
        partySize: input.partySize,
        quotedMinutes: input.quotedMinutes,
        notes: input.notes ?? null,
        customerId: customer?.id ?? null,
      },
    });
    this.events.changed(outletId);
    return this.waitDto(row);
  }

  /** Tell the guest their table is ready via the notification provider (SMS). */
  async notify(user: AuthUser, outletId: string, id: string): Promise<WaitlistEntryDto> {
    this.assertOutlet(user, outletId);
    const entry = await this.requireEntry(user, outletId, id);
    if (entry.status !== "WAITING" && entry.status !== "NOTIFIED") throw new BadRequestException("Guest is no longer waiting");
    if (!entry.phone) throw new BadRequestException("No phone number on this waitlist entry");
    const outlet = await this.prisma.outlet.findFirstOrThrow({ where: { id: outletId, tenantId: user.tenantId } });
    await this.notifier.send("SMS", entry.phone, `Hi ${entry.guestName}, your table at ${outlet.name} is ready. Please see the host.`);
    const row = await this.prisma.waitlistEntry.update({ where: { id }, data: { status: "NOTIFIED", notifiedAt: new Date() } });
    this.events.changed(outletId);
    return this.waitDto(row);
  }

  async seatFromWaitlist(user: AuthUser, outletId: string, id: string, tableId: string) {
    this.assertOutlet(user, outletId);
    const row = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM waitlist_entries WHERE id = ${id} AND "tenantId" = ${user.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
      if (!locked.length) throw new NotFoundException("Waitlist entry not found");
      const entry = await tx.waitlistEntry.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
      if (entry.status !== "WAITING" && entry.status !== "NOTIFIED") throw new BadRequestException("Guest is no longer waiting");
      await this.assertTableFree(tx, user.tenantId, outletId, tableId);
      return tx.waitlistEntry.update({ where: { id }, data: { status: "SEATED", seatedAt: new Date(), tableId } });
    });
    this.events.changed(outletId);
    return { tableId, entry: this.waitDto(row) };
  }

  async leaveWaitlist(user: AuthUser, outletId: string, id: string): Promise<WaitlistEntryDto> {
    this.assertOutlet(user, outletId);
    await this.requireEntry(user, outletId, id);
    const res = await this.prisma.waitlistEntry.updateMany({
      where: { id, tenantId: user.tenantId, outletId, status: { in: ["WAITING", "NOTIFIED"] } },
      data: { status: "LEFT" },
    });
    if (res.count === 0) throw new BadRequestException("Guest is no longer waiting");
    this.events.changed(outletId);
    return this.waitDto(await this.requireEntry(user, outletId, id));
  }

  private async requireEntry(user: AuthUser, outletId: string, id: string) {
    const entry = await this.prisma.waitlistEntry.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!entry) throw new NotFoundException("Waitlist entry not found");
    return entry;
  }

  private waitDto(w: Prisma.WaitlistEntryGetPayload<object>): WaitlistEntryDto {
    return {
      id: w.id,
      guestName: w.guestName,
      phone: w.phone,
      partySize: w.partySize,
      quotedMinutes: w.quotedMinutes,
      status: w.status as WaitlistStatus,
      notes: w.notes,
      tableId: w.tableId,
      notifiedAt: w.notifiedAt?.toISOString() ?? null,
      seatedAt: w.seatedAt?.toISOString() ?? null,
      createdAt: w.createdAt.toISOString(),
    };
  }
}
