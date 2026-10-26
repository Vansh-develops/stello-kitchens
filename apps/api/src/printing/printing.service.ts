import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  AuthUser,
  BillDto,
  ClaimPrintJobsInput,
  ClaimedPrintJobDto,
  CompletePrintJobInput,
  CreatePrinterInput,
  KotTicketDto,
  PrintJobDto,
  PrintJobKind,
  PrintJobStatus,
  PrintPayload,
  PrintRequestInput,
  PrintSettingsDto,
  PrinterDto,
  RecentBillDto,
  UpdatePrintSettingsInput,
  UpdatePrinterInput,
} from "@stello/shared";
import { Prisma, type Printer, type PrintJob } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { orderEvents, type OrderEvent } from "../common/order-events";
import { billFor, kotTicketFor, settingsDto } from "./print-documents";

const orderInclude = { table: true, items: { include: { addons: true } }, payments: true } as const;

/** A claimed job that is still PRINTING after this long is presumed lost and re-offered. */
const STALE_CLAIM_SECONDS = 120;
/** Queued jobs older than this are never auto-delivered (no surprise morning reprints). */
const MAX_JOB_AGE_HOURS = 12;

type JobDraft = {
  printer: Printer;
  kind: PrintJobKind;
  payload: PrintPayload;
  orderId?: string | null;
  kotId?: string | null;
  sourceKey?: string | null;
  reprint?: boolean;
  openDrawer?: boolean;
  createdById?: string | null;
};

/**
 * Printing for a cloud POS. The API cannot reach printers on a restaurant LAN,
 * so it never prints: it snapshots what to print as a job (QUEUED) and signals
 * the outlet over realtime. Whoever can reach the printer claims the job
 * atomically and reports back — the edge print agent for NETWORK/USB printers,
 * or a POS/KDS browser for BROWSER printers.
 */
@Injectable()
export class PrintingService implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit() {
    this.unsubscribe = orderEvents.on((e) => this.onOrderEvent(e));
  }

  onModuleDestroy() {
    this.unsubscribe?.();
  }

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  // ---------- printers ----------

  async listPrinters(user: AuthUser, outletId: string): Promise<PrinterDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.printer.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });
    return rows.map(toPrinterDto);
  }

  async createPrinter(user: AuthUser, outletId: string, input: CreatePrinterInput): Promise<PrinterDto> {
    this.assertOutlet(user, outletId);
    await this.assertStations(user.tenantId, outletId, input.stationIds);
    const row = await this.prisma.printer.create({
      data: { tenantId: user.tenantId, outletId, ...this.printerData(input), name: input.name, connection: input.connection },
    });
    return toPrinterDto(row);
  }

  async updatePrinter(user: AuthUser, outletId: string, id: string, input: UpdatePrinterInput): Promise<PrinterDto> {
    const existing = await this.requirePrinter(user, outletId, id);
    const connection = input.connection ?? existing.connection;
    const host = input.host !== undefined ? input.host : existing.host;
    const usbPath = input.usbPath !== undefined ? input.usbPath : existing.usbPath;
    if (connection === "NETWORK" && !host) throw new BadRequestException("Network printers need a host");
    if (connection === "USB" && !usbPath) throw new BadRequestException("USB printers need a device path");
    await this.assertStations(user.tenantId, outletId, input.stationIds);
    const row = await this.prisma.printer.update({
      where: { id: existing.id },
      data: { ...this.printerData(input), name: input.name, connection: input.connection },
    });
    return toPrinterDto(row);
  }

  async deletePrinter(user: AuthUser, outletId: string, id: string) {
    const existing = await this.requirePrinter(user, outletId, id);
    await this.prisma.$transaction([
      // Undelivered jobs for a removed printer can never print.
      this.prisma.printJob.updateMany({
        where: { printerId: existing.id, status: { in: ["QUEUED", "PRINTING"] } },
        data: { status: "CANCELLED", error: "Printer removed" },
      }),
      this.prisma.printer.delete({ where: { id: existing.id } }),
    ]);
    return { id: existing.id };
  }

  private printerData(input: UpdatePrinterInput) {
    return {
      host: input.host === undefined ? undefined : input.host || null,
      port: input.port,
      usbPath: input.usbPath === undefined ? undefined : input.usbPath || null,
      paperWidth: input.paperWidth,
      codepage: input.codepage,
      printKots: input.printKots,
      printBills: input.printBills,
      stationIds: input.stationIds,
      copies: input.copies,
      autoPrintKot: input.autoPrintKot,
      autoPrintBill: input.autoPrintBill,
      drawerKick: input.drawerKick,
      isActive: input.isActive,
    };
  }

  private async assertStations(tenantId: string, outletId: string, stationIds?: string[]) {
    if (!stationIds?.length) return;
    const found = await this.prisma.station.count({ where: { id: { in: stationIds }, tenantId, outletId } });
    if (found !== new Set(stationIds).size) throw new BadRequestException("Unknown station for this outlet");
  }

  private async requirePrinter(user: AuthUser, outletId: string, id: string) {
    this.assertOutlet(user, outletId);
    const p = await this.prisma.printer.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!p) throw new NotFoundException("Printer not found");
    return p;
  }

  // ---------- bill settings ----------

  async getSettings(user: AuthUser, outletId: string): Promise<PrintSettingsDto> {
    this.assertOutlet(user, outletId);
    return settingsDto(await this.prisma.outletPrintSettings.findFirst({ where: { tenantId: user.tenantId, outletId } }));
  }

  async updateSettings(user: AuthUser, outletId: string, input: UpdatePrintSettingsInput): Promise<PrintSettingsDto> {
    this.assertOutlet(user, outletId);
    const current = await this.getSettings(user, outletId);
    const next = { ...current, ...input };
    const data = {
      fssaiNumber: next.fssaiNumber || null,
      headerLines: next.headerLines.map((l) => l.trim()).filter(Boolean),
      footerLines: next.footerLines.map((l) => l.trim()).filter(Boolean),
      upiQrOnBill: next.upiQrOnBill,
    };
    const row = await this.prisma.outletPrintSettings.upsert({
      where: { outletId },
      create: { tenantId: user.tenantId, outletId, ...data },
      update: data,
    });
    return settingsDto(row);
  }

  // ---------- documents ----------

  private async loadOrder(tenantId: string, outletId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, tenantId, outletId }, include: orderInclude });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  private async userName(id: string | null) {
    if (!id) return null;
    return (await this.prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
  }

  async buildBill(tenantId: string, outletId: string, orderId: string, reprint: boolean): Promise<BillDto> {
    const order = await this.loadOrder(tenantId, outletId, orderId);
    if (order.status === "CANCELLED") throw new BadRequestException("Cancelled orders have no bill");
    const [outlet, settings, invoice, cashierName] = await Promise.all([
      this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, include: { brand: true } }),
      this.prisma.outletPrintSettings.findUnique({ where: { outletId } }),
      this.prisma.invoice.findUnique({ where: { orderId }, select: { buyerGstin: true } }),
      this.userName(order.createdById),
    ]);
    return billFor({
      order,
      outlet,
      brandName: outlet.brand.name,
      settings: settingsDto(settings),
      buyerGstin: invoice?.buyerGstin ?? null,
      cashierName,
      reprint,
    });
  }

  /** KOT tickets for one KOT: one per KOT printer that has items for it (or one unrouted preview). */
  private async kotTickets(
    tenantId: string,
    outletId: string,
    kotId: string,
    opts: { printers: Printer[] | null; reprint: boolean; cancelled: boolean; systemOrigin?: boolean },
  ): Promise<{ printer: Printer | null; ticket: KotTicketDto }[]> {
    const kot = await this.prisma.kot.findFirst({
      where: { id: kotId, tenantId, outletId },
      include: { items: { include: { addons: true } } },
    });
    if (!kot) throw new NotFoundException("KOT not found");
    const [order, outlet, stations] = await Promise.all([
      this.loadOrder(tenantId, outletId, kot.orderId),
      this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { name: true } }),
      this.prisma.station.findMany({ where: { tenantId, outletId }, select: { id: true, name: true } }),
    ]);
    const staffName = await this.userName(order.createdById);
    // Scan/aggregator punches have no staff actor (they may add to a POS-opened order).
    const system = opts.systemOrigin ?? !order.createdById;
    const source: KotTicketDto["source"] = !system ? "POS" : order.orderType === "DELIVERY" ? "AGGREGATOR" : "SCAN";
    const base = {
      kot,
      order,
      outletName: outlet.name,
      stationNames: new Map(stations.map((s) => [s.id, s.name])),
      staffName,
      source,
      reprint: opts.reprint,
      cancelled: opts.cancelled,
    };
    if (!opts.printers) {
      const ticket = kotTicketFor({ ...base, stationIds: [] });
      return ticket ? [{ printer: null, ticket }] : [];
    }
    return opts.printers.flatMap((printer) => {
      const ticket = kotTicketFor({ ...base, stationIds: stationIdsOf(printer) });
      return ticket ? [{ printer, ticket }] : [];
    });
  }

  async previewBill(user: AuthUser, outletId: string, orderId: string): Promise<BillDto> {
    this.assertOutlet(user, outletId);
    return this.buildBill(user.tenantId, outletId, orderId, false);
  }

  async previewKot(user: AuthUser, outletId: string, kotId: string): Promise<KotTicketDto[]> {
    this.assertOutlet(user, outletId);
    return (await this.kotTickets(user.tenantId, outletId, kotId, { printers: null, reprint: true, cancelled: false })).map(
      (t) => t.ticket,
    );
  }

  // ---------- automatic jobs (order lifecycle) ----------

  async onOrderEvent(e: OrderEvent) {
    if (e.type === "kot.created") await this.autoKots(e);
    else if (e.type === "order.settled") await this.autoBill(e);
    else if (e.type === "order.cancelled") await this.cancellationKots(e);
  }

  private activePrinters(tenantId: string, outletId: string, where: Prisma.PrinterWhereInput) {
    return this.prisma.printer.findMany({ where: { tenantId, outletId, isActive: true, ...where }, orderBy: { name: "asc" } });
  }

  /** Auto-print KOTs of an order that have never been sent to any printer. */
  private async autoKots(e: Extract<OrderEvent, { type: "kot.created" }>) {
    const printers = await this.activePrinters(e.tenantId, e.outletId, { printKots: true, autoPrintKot: true });
    if (!printers.length) return;
    const kots = await this.prisma.kot.findMany({
      where: { tenantId: e.tenantId, outletId: e.outletId, orderId: e.orderId, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
      select: { id: true },
    });
    const printed = new Set(
      (await this.prisma.printJob.findMany({ where: { kotId: { in: kots.map((k) => k.id) } }, select: { kotId: true } })).map((j) => j.kotId),
    );
    const drafts: JobDraft[] = [];
    for (const kot of kots.filter((k) => !printed.has(k.id))) {
      for (const { printer, ticket } of await this.kotTickets(e.tenantId, e.outletId, kot.id, { printers, reprint: false, cancelled: false, systemOrigin: !e.userId })) {
        drafts.push({
          printer: printer!,
          kind: "KOT",
          payload: { kind: "KOT", ticket },
          orderId: e.orderId,
          kotId: kot.id,
          sourceKey: `auto-kot:${kot.id}:${printer!.id}`,
          createdById: e.userId,
        });
      }
    }
    await this.enqueue(e.tenantId, e.outletId, drafts);
  }

  /** Bill (and drawer kick for cash) on settlement. */
  private async autoBill(e: Extract<OrderEvent, { type: "order.settled" }>) {
    const printers = await this.activePrinters(e.tenantId, e.outletId, { OR: [{ printBills: true, autoPrintBill: true }, { drawerKick: true }] });
    if (!printers.length) return;
    const order = await this.prisma.order.findFirst({ where: { id: e.orderId, tenantId: e.tenantId }, include: { payments: true } });
    if (!order) return;
    const cash = order.payments.some((p) => p.mode === "CASH");
    const billPrinters = printers.filter((p) => p.printBills && p.autoPrintBill);
    const bill = billPrinters.length ? await this.buildBill(e.tenantId, e.outletId, e.orderId, false) : null;
    const drafts: JobDraft[] = [];
    for (const printer of printers) {
      const prints = bill && printer.printBills && printer.autoPrintBill;
      if (prints) {
        drafts.push({
          printer,
          kind: "BILL",
          payload: { kind: "BILL", bill: bill! },
          orderId: e.orderId,
          sourceKey: `auto-bill:${e.orderId}:${printer.id}`,
          openDrawer: cash && printer.drawerKick,
          createdById: e.userId,
        });
      } else if (cash && printer.drawerKick) {
        drafts.push({
          printer,
          kind: "DRAWER",
          payload: { kind: "DRAWER" },
          orderId: e.orderId,
          sourceKey: `auto-drawer:${e.orderId}:${printer.id}`,
          openDrawer: true,
          createdById: e.userId,
        });
      }
    }
    await this.enqueue(e.tenantId, e.outletId, drafts);
  }

  /** A voided order tells the kitchen to stop: one CANCELLED ticket per unserved KOT. */
  private async cancellationKots(e: Extract<OrderEvent, { type: "order.cancelled" }>) {
    const printers = await this.activePrinters(e.tenantId, e.outletId, { printKots: true, autoPrintKot: true });
    if (!printers.length) return;
    const kots = await this.prisma.kot.findMany({
      where: { tenantId: e.tenantId, outletId: e.outletId, orderId: e.orderId, status: { not: "SERVED" } },
      select: { id: true },
    });
    const drafts: JobDraft[] = [];
    for (const kot of kots) {
      for (const { printer, ticket } of await this.kotTickets(e.tenantId, e.outletId, kot.id, { printers, reprint: false, cancelled: true })) {
        drafts.push({
          printer: printer!,
          kind: "KOT",
          payload: { kind: "KOT", ticket },
          orderId: e.orderId,
          kotId: kot.id,
          sourceKey: `cancel-kot:${kot.id}:${printer!.id}`,
          createdById: e.userId,
        });
      }
    }
    await this.enqueue(e.tenantId, e.outletId, drafts);
  }

  // ---------- manual jobs ----------

  private async targetPrinters(user: AuthUser, outletId: string, input: PrintRequestInput, role: "printKots" | "printBills") {
    if (input.printerId) {
      const p = await this.requirePrinter(user, outletId, input.printerId);
      if (!p.isActive) throw new BadRequestException("Printer is disabled");
      return [p];
    }
    const printers = await this.activePrinters(user.tenantId, outletId, { [role]: true });
    if (!printers.length) throw new BadRequestException(role === "printKots" ? "No KOT printer is set up" : "No bill printer is set up");
    return printers;
  }

  /** Reprint a KOT to its station printers (or one chosen printer). */
  async printKot(user: AuthUser, outletId: string, kotId: string, input: PrintRequestInput): Promise<PrintJobDto[]> {
    this.assertOutlet(user, outletId);
    const printers = await this.targetPrinters(user, outletId, input, "printKots");
    const tickets = await this.kotTickets(user.tenantId, outletId, kotId, { printers, reprint: true, cancelled: false });
    if (!tickets.length) throw new BadRequestException("None of the KOT printers handle this KOT's stations");
    const kot = await this.prisma.kot.findUniqueOrThrow({ where: { id: kotId }, select: { orderId: true } });
    return this.enqueue(
      user.tenantId,
      outletId,
      tickets.map(({ printer, ticket }) => ({
        printer: printer!,
        kind: "KOT" as const,
        payload: { kind: "KOT" as const, ticket },
        orderId: kot.orderId,
        kotId,
        reprint: true,
        createdById: user.id,
      })),
    );
  }

  /** Print a bill: a pro-forma for an open order, the tax invoice (marked DUPLICATE) once settled. */
  async printBill(user: AuthUser, outletId: string, orderId: string, input: PrintRequestInput): Promise<PrintJobDto[]> {
    this.assertOutlet(user, outletId);
    const order = await this.loadOrder(user.tenantId, outletId, orderId);
    const printers = await this.targetPrinters(user, outletId, input, "printBills");
    // A settled bill printed before is a DUPLICATE; the first print is the original.
    const reprint =
      order.status === "SETTLED" &&
      (await this.prisma.printJob.count({ where: { tenantId: user.tenantId, orderId, kind: "BILL", status: { not: "CANCELLED" } } })) > 0;
    const bill = await this.buildBill(user.tenantId, outletId, orderId, reprint);
    return this.enqueue(
      user.tenantId,
      outletId,
      printers.map((printer) => ({ printer, kind: "BILL" as const, payload: { kind: "BILL" as const, bill }, orderId, reprint, createdById: user.id })),
    );
  }

  async testPrint(user: AuthUser, outletId: string, printerId: string): Promise<PrintJobDto> {
    const printer = await this.requirePrinter(user, outletId, printerId);
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { name: true } });
    const [job] = await this.enqueue(user.tenantId, outletId, [
      {
        printer,
        kind: "TEST",
        payload: {
          kind: "TEST",
          test: {
            printerName: printer.name,
            outletName: outlet.name,
            connection: printer.connection as PrinterDto["connection"],
            paperWidth: printer.paperWidth as PrinterDto["paperWidth"],
            codepage: printer.codepage as PrinterDto["codepage"],
            requestedAt: new Date().toISOString(),
          },
        },
        createdById: user.id,
      },
    ]);
    return job;
  }

  /** Open the cash drawer without a sale ("no sale"). */
  async kickDrawer(user: AuthUser, outletId: string, input: PrintRequestInput): Promise<PrintJobDto[]> {
    this.assertOutlet(user, outletId);
    const printers = input.printerId
      ? [await this.requirePrinter(user, outletId, input.printerId)]
      : await this.activePrinters(user.tenantId, outletId, { drawerKick: true });
    if (!printers.length) throw new BadRequestException("No printer has a cash drawer attached");
    const jobs = await this.enqueue(
      user.tenantId,
      outletId,
      printers.map((printer) => ({ printer, kind: "DRAWER" as const, payload: { kind: "DRAWER" as const }, openDrawer: true, createdById: user.id })),
    );
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "DRAWER_OPENED", entity: "outlet", entityId: outletId },
    });
    return jobs;
  }

  /**
   * Insert jobs and signal the outlet. Automatic jobs carry a sourceKey so a
   * re-delivered event (or two racing punches) can't print a ticket twice.
   */
  private async enqueue(tenantId: string, outletId: string, drafts: JobDraft[]): Promise<PrintJobDto[]> {
    if (!drafts.length) return [];
    const created: (PrintJob & { printer: Printer | null })[] = [];
    for (const d of drafts) {
      try {
        created.push(
          await this.prisma.printJob.create({
            data: {
              tenantId,
              outletId,
              printerId: d.printer.id,
              kind: d.kind,
              payload: d.payload as unknown as Prisma.InputJsonValue,
              copies: d.printer.copies,
              reprint: d.reprint ?? false,
              openDrawer: d.openDrawer ?? false,
              orderId: d.orderId ?? null,
              kotId: d.kotId ?? null,
              sourceKey: d.sourceKey ?? null,
              createdById: d.createdById ?? null,
            },
            include: { printer: true },
          }),
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
    if (created.length) this.signal(outletId, "print:queued", created.map((j) => j.id));
    return created.map(toJobDto);
  }

  private signal(outletId: string, event: "print:queued" | "print:updated", jobIds: string[]) {
    this.realtime.server?.to(`outlet:${outletId}`).emit(event, { outletId, jobIds });
  }

  // ---------- job lifecycle ----------

  async listJobs(user: AuthUser, outletId: string, status?: string, orderId?: string): Promise<PrintJobDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.printJob.findMany({
      where: {
        tenantId: user.tenantId,
        outletId,
        ...(status ? { status } : {}),
        ...(orderId ? { orderId } : {}),
      },
      include: { printer: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map(toJobDto);
  }

  /**
   * Atomically take up to `limit` deliverable jobs. FOR UPDATE SKIP LOCKED lets
   * several agents/terminals poll the same outlet without ever handing one job
   * to two of them; a claim left PRINTING past STALE_CLAIM_SECONDS (agent died
   * mid-job) is offered again.
   */
  async claim(user: AuthUser, outletId: string, input: ClaimPrintJobsInput): Promise<ClaimedPrintJobDto[]> {
    this.assertOutlet(user, outletId);
    if (input.printerIds && input.printerIds.length === 0) return [];
    const filters: Prisma.Sql[] = [];
    if (input.printerIds) filters.push(Prisma.sql`AND j."printerId" IN (${Prisma.join(input.printerIds)})`);
    if (input.connections?.length) filters.push(Prisma.sql`AND p."connection" IN (${Prisma.join(input.connections)})`);
    if (input.mine) filters.push(Prisma.sql`AND j."createdById" = ${user.id}`);
    if (input.olderThanSeconds) {
      filters.push(Prisma.sql`AND j."createdAt" < ${new Date(Date.now() - input.olderThanSeconds * 1000)}`);
    }
    // Timestamps are bound from JS (UTC, like every Prisma write) rather than now(),
    // so the comparison never depends on the database session time zone.
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_SECONDS * 1000);
    const oldestAllowed = new Date(now.getTime() - MAX_JOB_AGE_HOURS * 3_600_000);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH picked AS (
        SELECT j.id FROM print_jobs j
        JOIN printers p ON p.id = j."printerId"
        WHERE j."tenantId" = ${user.tenantId} AND j."outletId" = ${outletId}
          AND p."tenantId" = ${user.tenantId} AND p."isActive" = true
          AND (j.status = 'QUEUED'
               OR (j.status = 'PRINTING' AND j."claimedAt" < ${staleBefore}))
          AND j."createdAt" > ${oldestAllowed}
          ${filters.length ? Prisma.join(filters, " ") : Prisma.empty}
        ORDER BY j."createdAt"
        LIMIT ${input.limit ?? 5}::int
        FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE print_jobs SET status = 'PRINTING', "claimedBy" = ${input.agentId}, "claimedAt" = ${now},
        attempts = print_jobs.attempts + 1, error = NULL
      FROM picked WHERE print_jobs.id = picked.id
      RETURNING print_jobs.id`;
    if (!rows.length) return [];
    const jobs = await this.prisma.printJob.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      include: { printer: true },
      orderBy: { createdAt: "asc" },
    });
    return jobs.map((j) => ({ ...toJobDto(j), printer: j.printer ? toPrinterDto(j.printer) : null }));
  }

  async complete(user: AuthUser, jobId: string, input: CompletePrintJobInput): Promise<PrintJobDto> {
    const job = await this.requireJob(user, jobId);
    if (job.status !== "PRINTING") throw new BadRequestException(`Job is ${job.status.toLowerCase()}, not printing`);
    if (input.agentId && job.claimedBy && input.agentId !== job.claimedBy) {
      throw new BadRequestException("Job is claimed by another printer agent");
    }
    // Conditional update: a stale claimant can't overwrite a newer outcome.
    const updated = await this.prisma.printJob.updateMany({
      where: { id: job.id, status: "PRINTING", claimedAt: job.claimedAt },
      data: input.ok
        ? { status: "PRINTED", printedAt: new Date(), error: null }
        : { status: "FAILED", error: input.error?.slice(0, 300) || "Printer did not accept the job" },
    });
    if (updated.count !== 1) throw new BadRequestException("Job was re-claimed; result ignored");
    this.signal(job.outletId, "print:updated", [job.id]);
    return this.jobDto(job.id);
  }

  /** Put a failed/cancelled job back in the queue as-is. */
  async retry(user: AuthUser, jobId: string): Promise<PrintJobDto> {
    const job = await this.requireJob(user, jobId);
    if (job.status !== "FAILED" && job.status !== "CANCELLED") throw new BadRequestException("Only failed or cancelled jobs can be retried");
    if (!job.printerId) throw new BadRequestException("The job's printer was removed");
    await this.prisma.printJob.update({ where: { id: job.id }, data: { status: "QUEUED", error: null, claimedBy: null, claimedAt: null } });
    this.signal(job.outletId, "print:queued", [job.id]);
    return this.jobDto(job.id);
  }

  async cancelJob(user: AuthUser, jobId: string): Promise<PrintJobDto> {
    const job = await this.requireJob(user, jobId);
    const res = await this.prisma.printJob.updateMany({
      where: { id: job.id, status: { in: ["QUEUED", "FAILED"] } },
      data: { status: "CANCELLED" },
    });
    if (res.count !== 1) throw new BadRequestException("Only queued or failed jobs can be cancelled");
    this.signal(job.outletId, "print:updated", [job.id]);
    return this.jobDto(job.id);
  }

  /** Print a job's exact snapshot again, marked as a reprint/duplicate; never re-kicks the drawer. */
  async reprint(user: AuthUser, jobId: string): Promise<PrintJobDto> {
    const job = await this.requireJob(user, jobId);
    if (!job.printer) throw new BadRequestException("The job's printer was removed");
    if (job.kind === "DRAWER") throw new BadRequestException("Drawer kicks can't be reprinted");
    const payload = markReprint(job.payload as unknown as PrintPayload);
    const [created] = await this.enqueue(job.tenantId, job.outletId, [
      { printer: job.printer, kind: job.kind as PrintJobKind, payload, orderId: job.orderId, kotId: job.kotId, reprint: true, createdById: user.id },
    ]);
    return created;
  }

  async recentBills(user: AuthUser, outletId: string): Promise<RecentBillDto[]> {
    this.assertOutlet(user, outletId);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "SETTLED" },
      include: { table: true },
      orderBy: { updatedAt: "desc" },
      take: 30,
    });
    return orders.map((o) => ({
      orderId: o.id,
      billNumber: o.billNumber,
      tableName: o.table?.name ?? null,
      orderType: o.orderType,
      total: Number(o.total),
      settledAt: o.updatedAt.toISOString(),
    }));
  }

  private async requireJob(user: AuthUser, jobId: string) {
    const job = await this.prisma.printJob.findUnique({ where: { id: jobId }, include: { printer: true } });
    if (!job || job.tenantId !== user.tenantId) throw new NotFoundException("Print job not found");
    this.assertOutlet(user, job.outletId);
    return job;
  }

  private async jobDto(id: string) {
    return toJobDto(await this.prisma.printJob.findUniqueOrThrow({ where: { id }, include: { printer: true } }));
  }
}

// ---------- mapping ----------

function stationIdsOf(p: Printer): string[] {
  return Array.isArray(p.stationIds) ? p.stationIds.filter((s): s is string => typeof s === "string") : [];
}

export function toPrinterDto(p: Printer): PrinterDto {
  return {
    id: p.id,
    name: p.name,
    connection: p.connection as PrinterDto["connection"],
    host: p.host,
    port: p.port,
    usbPath: p.usbPath,
    paperWidth: p.paperWidth === 58 ? 58 : 80,
    codepage: p.codepage as PrinterDto["codepage"],
    printKots: p.printKots,
    printBills: p.printBills,
    stationIds: stationIdsOf(p),
    copies: p.copies,
    autoPrintKot: p.autoPrintKot,
    autoPrintBill: p.autoPrintBill,
    drawerKick: p.drawerKick,
    isActive: p.isActive,
  };
}

function toJobDto(j: PrintJob & { printer: Printer | null }): PrintJobDto {
  return {
    id: j.id,
    printerId: j.printerId,
    printerName: j.printer?.name ?? null,
    kind: j.kind as PrintJobKind,
    status: j.status as PrintJobStatus,
    payload: j.payload as unknown as PrintPayload,
    copies: j.copies,
    reprint: j.reprint,
    openDrawer: j.openDrawer,
    attempts: j.attempts,
    error: j.error,
    orderId: j.orderId,
    kotId: j.kotId,
    claimedBy: j.claimedBy,
    createdById: j.createdById,
    createdAt: j.createdAt.toISOString(),
    printedAt: j.printedAt?.toISOString() ?? null,
  };
}

function markReprint(payload: PrintPayload): PrintPayload {
  if (payload.kind === "KOT") return { kind: "KOT", ticket: { ...payload.ticket, reprint: true } };
  if (payload.kind === "BILL") return { kind: "BILL", bill: { ...payload.bill, reprint: true, provisional: payload.bill.provisional } };
  return payload;
}
