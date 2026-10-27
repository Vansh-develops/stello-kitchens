import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { ReportSchedule } from "@prisma/client";
import type { AuthUser, ReportExportKey, ReportScheduleDto, ReportScheduleInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email.provider";
import { ReportExportService } from "./report-export.service";
import { renderToBuffer } from "./report-writer";

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

/**
 * Next send time strictly after `after`, in server-local time (the same clock
 * the reports use for day boundaries). WEEKLY uses `weekday` (0 = Sunday).
 */
export function computeNextRun(s: { frequency: string; weekday: number | null; hour: number }, after: Date): Date {
  const next = new Date(after);
  next.setMinutes(0, 0, 0);
  next.setHours(s.hour);
  if (next <= after) next.setDate(next.getDate() + 1);
  if (s.frequency === "WEEKLY") {
    const want = s.weekday ?? 1;
    while (next.getDay() !== want) next.setDate(next.getDate() + 1);
  }
  return next;
}

/** Completed days a run reports on: yesterday (daily) or the 7 days ending yesterday (weekly). */
export function reportWindow(frequency: string, runAt: Date): { from: string; to: string } {
  const end = new Date(runAt);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  if (frequency === "WEEKLY") start.setDate(start.getDate() - 6);
  return { from: ymd(start), to: ymd(end) };
}

/**
 * Daily/weekly report emails per outlet. A DB-backed scheduler (no extra infra):
 * every minute each API instance looks for due rows and claims each one with a
 * compare-and-set on `nextRunAt`, so only one instance sends a given run.
 */
@Injectable()
export class ReportSchedulesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("ReportSchedules");
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly exporter: ReportExportService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === "test" || process.env.REPORT_SCHEDULER_DISABLED === "true") return;
    this.timer = setInterval(() => void this.runDue(), Number(process.env.REPORT_SCHEDULER_INTERVAL_MS || 60_000));
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async list(user: AuthUser, outletId: string): Promise<ReportScheduleDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.reportSchedule.findMany({ where: { tenantId: user.tenantId, outletId }, orderBy: { createdAt: "asc" } });
    return rows.map(toDto);
  }

  async create(user: AuthUser, outletId: string, input: ReportScheduleInput): Promise<ReportScheduleDto> {
    this.assertOutlet(user, outletId);
    const weekday = input.frequency === "WEEKLY" ? (input.weekday ?? 1) : null;
    const row = await this.prisma.reportSchedule.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        name: input.name,
        frequency: input.frequency,
        weekday,
        hour: input.hour,
        recipients: [...new Set(input.recipients.map((r) => r.toLowerCase()))],
        reports: [...new Set(input.reports)],
        format: input.format,
        isActive: input.isActive,
        nextRunAt: computeNextRun({ frequency: input.frequency, weekday, hour: input.hour }, new Date()),
        createdById: user.id,
      },
    });
    await this.audit(user, "REPORT_SCHEDULE_CREATED", row.id, { name: row.name, recipients: row.recipients });
    return toDto(row);
  }

  async update(user: AuthUser, outletId: string, id: string, input: ReportScheduleInput): Promise<ReportScheduleDto> {
    const row = await this.require(user, outletId, id);
    const weekday = input.frequency === "WEEKLY" ? (input.weekday ?? 1) : null;
    const updated = await this.prisma.reportSchedule.update({
      where: { id: row.id },
      data: {
        name: input.name,
        frequency: input.frequency,
        weekday,
        hour: input.hour,
        recipients: [...new Set(input.recipients.map((r) => r.toLowerCase()))],
        reports: [...new Set(input.reports)],
        format: input.format,
        isActive: input.isActive,
        nextRunAt: computeNextRun({ frequency: input.frequency, weekday, hour: input.hour }, new Date()),
      },
    });
    await this.audit(user, "REPORT_SCHEDULE_UPDATED", row.id, { name: updated.name, recipients: updated.recipients });
    return toDto(updated);
  }

  async remove(user: AuthUser, outletId: string, id: string): Promise<{ id: string }> {
    const row = await this.require(user, outletId, id);
    await this.prisma.reportSchedule.delete({ where: { id: row.id } });
    await this.audit(user, "REPORT_SCHEDULE_DELETED", row.id, { name: row.name });
    return { id: row.id };
  }

  /** "Send now" from the console; does not move the regular schedule. */
  async sendNow(user: AuthUser, outletId: string, id: string): Promise<ReportScheduleDto> {
    const row = await this.require(user, outletId, id);
    await this.execute(row, new Date());
    return toDto(await this.prisma.reportSchedule.findUniqueOrThrow({ where: { id: row.id } }));
  }

  /** Scheduler tick: claim and send every due schedule. Returns how many ran. */
  async runDue(now: Date = new Date()): Promise<number> {
    const due = await runUnscoped(() =>
      this.prisma.reportSchedule.findMany({ where: { isActive: true, nextRunAt: { lte: now } }, take: 25, orderBy: { nextRunAt: "asc" } }),
    );
    let ran = 0;
    for (const s of due) {
      const claimed = await runUnscoped(() =>
        this.prisma.reportSchedule.updateMany({
          where: { id: s.id, nextRunAt: s.nextRunAt },
          data: { nextRunAt: computeNextRun(s, now) },
        }),
      );
      if (claimed.count !== 1) continue; // another instance took it
      await this.execute(s, now);
      ran++;
    }
    return ran;
  }

  private async execute(s: ReportSchedule, runAt: Date): Promise<void> {
    try {
      if (!this.email.sendReport) throw new Error("The configured email provider cannot send report attachments");
      const outlets = await runUnscoped(() =>
        this.prisma.outlet.findMany({ where: { tenantId: s.tenantId }, select: { id: true, name: true } }),
      );
      const outlet = outlets.find((o) => o.id === s.outletId);
      if (!outlet) throw new Error("Outlet no longer exists");
      // A system principal limited to reading this tenant's reports.
      const principal: AuthUser = {
        id: s.createdById ?? "system",
        tenantId: s.tenantId,
        email: "",
        name: "Report scheduler",
        roleName: "system",
        permissions: ["reports.view"],
        outletIds: outlets.map((o) => o.id),
        isPlatformAdmin: false,
      };
      const { from, to } = reportWindow(s.frequency, runAt);
      const keys = strings(s.reports) as ReportExportKey[];
      const sheets = await runUnscoped(() => this.exporter.sheets(principal, s.outletId, keys, from, to));
      const format = s.format === "CSV" ? "csv" : "xlsx";
      const content = await renderToBuffer(sheets, format);
      const period = from === to ? from : `${from} to ${to}`;
      const subject = `${s.name}: ${outlet.name} (${period})`;
      const text = [
        `Your ${s.frequency.toLowerCase()} Stello Kitchens report for ${outlet.name}, covering ${period}.`,
        "",
        `Included: ${keys.map((k) => this.exporter.label(k)).join(", ")}.`,
        "",
        "You receive this because an admin added you to a scheduled report. Ask them to remove you to stop it.",
      ].join("\n");
      await this.email.sendReport(strings(s.recipients), subject, text, [
        {
          filename: `stello-${s.frequency.toLowerCase()}-${to}.${format}`,
          contentType: format === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          content,
        },
      ]);
      await runUnscoped(() =>
        this.prisma.reportSchedule.update({ where: { id: s.id }, data: { lastRunAt: runAt, lastStatus: "SENT", lastError: null } }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`schedule ${s.id} failed: ${message}`);
      await runUnscoped(() =>
        this.prisma.reportSchedule.update({ where: { id: s.id }, data: { lastRunAt: runAt, lastStatus: "FAILED", lastError: message.slice(0, 500) } }),
      );
    }
  }

  private async require(user: AuthUser, outletId: string, id: string) {
    this.assertOutlet(user, outletId);
    const row = await this.prisma.reportSchedule.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!row) throw new NotFoundException("Schedule not found");
    return row;
  }

  private audit(user: AuthUser, action: string, entityId: string, data: object) {
    return this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action, entity: "report_schedule", entityId, data: data as never },
    });
  }
}

function toDto(r: ReportSchedule): ReportScheduleDto {
  return {
    id: r.id,
    outletId: r.outletId,
    name: r.name,
    frequency: r.frequency as ReportScheduleDto["frequency"],
    weekday: r.weekday,
    hour: r.hour,
    recipients: strings(r.recipients),
    reports: strings(r.reports) as ReportExportKey[],
    format: r.format as ReportScheduleDto["format"],
    isActive: r.isActive,
    nextRunAt: r.nextRunAt.toISOString(),
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
  };
}

