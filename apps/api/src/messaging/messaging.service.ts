import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  MESSAGING_PURPOSE_VARS,
  nationalPhone,
  type AuthUser,
  type CampaignStatsDto,
  type LowStockRecipient,
  type MessagingChannel,
  type MessagingConfigDto,
  type MessagingConfigInput,
  type MessagingPurpose,
  type OptOutDto,
  type OptOutInput,
  type OutboxMessageDto,
  type OutboxStatus,
  type PurposeTemplates,
} from "@stello/shared";
import { Prisma, type MessageOutbox, type MessagingConfig } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email.provider";
import { ProviderHttpError } from "../integrations/http";
import { startJobLoop } from "../integrations/job-loop";
import { SMS_TRANSPORT, WHATSAPP_TRANSPORT, type SendResult, type SmsTransport, type WhatsAppTransport } from "./transports";

const MAX_ATTEMPTS = 5;
const STATUS_RANK: Record<string, number> = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 5, SKIPPED: 5 };

export interface SendRequest {
  tenantId: string;
  outletId?: string | null;
  purpose: MessagingPurpose;
  channel: MessagingChannel;
  to: string;
  body: string; // human-readable text (log/email body)
  vars: string[]; // ordered template variables for the purpose
  campaignId?: string | null;
}

/**
 * Outbound messaging: per-tenant sender config, opt-outs, a persistent outbox
 * (queued → sent → delivered/read), per-tenant rate limiting, retries with
 * backoff, and provider delivery receipts. OTPs bypass the queue (sent inline)
 * but are still recorded in the outbox for delivery status.
 */
@Injectable()
export class MessagingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingService.name);
  private stopJob: () => void = () => undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SMS_TRANSPORT) private readonly sms: SmsTransport,
    @Inject(WHATSAPP_TRANSPORT) private readonly whatsapp: WhatsAppTransport,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  onModuleInit() {
    this.stopJob = startJobLoop("messaging-outbox", Number(process.env.MESSAGING_DISPATCH_INTERVAL_MS ?? 5_000), () => this.processOutbox());
  }
  onModuleDestroy() {
    this.stopJob();
  }

  // ---------- Config ----------

  private async rawConfig(tenantId: string): Promise<MessagingConfig | null> {
    return runUnscoped(() => this.prisma.messagingConfig.findUnique({ where: { tenantId } }));
  }

  async getConfig(user: Pick<AuthUser, "tenantId">): Promise<MessagingConfigDto> {
    const c = await this.rawConfig(user.tenantId);
    return {
      smsEnabled: c?.smsEnabled ?? true,
      whatsappEnabled: c?.whatsappEnabled ?? true,
      emailEnabled: c?.emailEnabled ?? true,
      smsSenderId: c?.smsSenderId ?? null,
      whatsappPhoneNumberId: c?.whatsappPhoneNumberId ?? null,
      otpChannel: (c?.otpChannel as "SMS" | "WHATSAPP") ?? "SMS",
      templates: (c?.templates as MessagingConfigInput["templates"]) ?? {},
      ratePerMinute: c?.ratePerMinute ?? 60,
      lowStockEnabled: c?.lowStockEnabled ?? true,
      lowStockRecipients: (c?.lowStockRecipients as LowStockRecipient[]) ?? [],
      transports: { sms: this.sms.name, whatsapp: this.whatsapp.name, email: this.email.constructor.name === "SmtpEmailProvider" ? "smtp" : "log" },
    };
  }

  async saveConfig(user: AuthUser, input: MessagingConfigInput): Promise<MessagingConfigDto> {
    const data = {
      smsEnabled: input.smsEnabled,
      whatsappEnabled: input.whatsappEnabled,
      emailEnabled: input.emailEnabled,
      smsSenderId: input.smsSenderId ?? null,
      whatsappPhoneNumberId: input.whatsappPhoneNumberId ?? null,
      otpChannel: input.otpChannel,
      templates: input.templates as Prisma.InputJsonValue,
      ratePerMinute: input.ratePerMinute,
      lowStockEnabled: input.lowStockEnabled,
      lowStockRecipients: input.lowStockRecipients as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.messagingConfig.upsert({ where: { tenantId: user.tenantId }, create: { tenantId: user.tenantId, ...data }, update: data });
    return this.getConfig(user);
  }

  // ---------- Opt-outs ----------

  async isOptedOut(tenantId: string, phoneOrEmail: string, channel: MessagingChannel): Promise<boolean> {
    const key = channel === "EMAIL" ? phoneOrEmail.trim().toLowerCase() : nationalPhone(phoneOrEmail);
    const hit = await runUnscoped(() =>
      this.prisma.messagingOptOut.findFirst({ where: { tenantId, phone: key, channel: { in: [channel, "ALL"] } } }),
    );
    return !!hit;
  }

  async optOut(tenantId: string, input: OptOutInput, source: string) {
    const phone = input.channel === "EMAIL" ? input.phone.trim().toLowerCase() : nationalPhone(input.phone);
    return runUnscoped(() =>
      this.prisma.messagingOptOut.upsert({
        where: { tenantId_phone_channel: { tenantId, phone, channel: input.channel } },
        create: { tenantId, phone, channel: input.channel, source },
        update: {},
      }),
    );
  }

  async listOptOuts(user: AuthUser): Promise<OptOutDto[]> {
    const rows = await this.prisma.messagingOptOut.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" }, take: 500 });
    return rows.map((r) => ({ id: r.id, phone: r.phone, channel: r.channel, source: r.source, createdAt: r.createdAt.toISOString() }));
  }

  async removeOptOut(user: AuthUser, id: string) {
    const row = await this.prisma.messagingOptOut.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!row) throw new NotFoundException("Opt-out not found");
    await this.prisma.messagingOptOut.delete({ where: { id } });
    return { id };
  }

  // ---------- Sending ----------

  /**
   * Queue a message. Marketing (CAMPAIGN) respects opt-outs and the channel
   * switch; the row is created SKIPPED instead so campaign stats stay honest.
   */
  async enqueue(req: SendRequest): Promise<MessageOutbox> {
    const skip = await this.skipReason(req);
    return runUnscoped(() =>
      this.prisma.messageOutbox.create({
        data: {
          tenantId: req.tenantId,
          outletId: req.outletId ?? null,
          campaignId: req.campaignId ?? null,
          purpose: req.purpose,
          channel: req.channel,
          recipient: req.to,
          body: req.body,
          vars: req.vars,
          status: skip ? "SKIPPED" : "QUEUED",
          error: skip,
        },
      }),
    );
  }

  /** Send now (OTP). Throws when the provider rejects so the caller can tell the cashier. */
  async sendNow(req: SendRequest): Promise<MessageOutbox> {
    const row = await this.enqueue(req);
    if (row.status === "SKIPPED") throw new BadRequestException(row.error ?? "Message not allowed");
    const claimed = await runUnscoped(() =>
      this.prisma.messageOutbox.update({ where: { id: row.id }, data: { status: "SENDING", attempts: 1 } }),
    );
    const done = await this.deliver(claimed);
    if (done.status === "FAILED" || done.status === "QUEUED") {
      throw new BadRequestException(`Could not send ${req.channel === "WHATSAPP" ? "WhatsApp" : req.channel} message: ${done.error ?? "provider error"}`);
    }
    return done;
  }

  private async skipReason(req: SendRequest): Promise<string | null> {
    const cfg = await this.rawConfig(req.tenantId);
    const enabled = req.channel === "SMS" ? (cfg?.smsEnabled ?? true) : req.channel === "WHATSAPP" ? (cfg?.whatsappEnabled ?? true) : (cfg?.emailEnabled ?? true);
    if (!enabled) return `${req.channel} is disabled for this restaurant`;
    if (req.purpose === "CAMPAIGN" && (await this.isOptedOut(req.tenantId, req.to, req.channel))) return "Recipient opted out";
    return null;
  }

  /** Dispatch one claimed (SENDING) row and record the outcome. */
  private async deliver(row: MessageOutbox): Promise<MessageOutbox> {
    try {
      const res = await this.dispatch(row);
      return await runUnscoped(() =>
        this.prisma.messageOutbox.update({
          where: { id: row.id },
          data: { status: "SENT", provider: res.provider, providerMessageId: res.messageId, sentAt: new Date(), error: null },
        }),
      );
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      // 4xx = permanent (bad template/number); transport errors and 5xx retry with backoff.
      const permanent = e instanceof ProviderHttpError ? !e.uncertain && e.status !== 429 : e instanceof BadRequestException;
      const retry = !permanent && row.attempts < MAX_ATTEMPTS && row.purpose !== "OTP";
      this.logger.warn(`outbox ${row.id} (${row.channel}) failed: ${msg}`);
      return runUnscoped(() =>
        this.prisma.messageOutbox.update({
          where: { id: row.id },
          data: retry
            ? { status: "QUEUED", error: msg, nextAttemptAt: new Date(Date.now() + 30_000 * 2 ** (row.attempts - 1)) }
            : { status: "FAILED", error: msg },
        }),
      );
    }
  }

  private async dispatch(row: MessageOutbox): Promise<SendResult> {
    const cfg = await this.rawConfig(row.tenantId);
    const purpose = row.purpose as MessagingPurpose;
    const vars = (Array.isArray(row.vars) ? row.vars : []).map(String);
    const tpl = ((cfg?.templates as Record<string, PurposeTemplates> | null) ?? {})[purpose] ?? {};
    if (row.channel === "EMAIL") {
      const subject = purpose === "LOW_STOCK" ? `Low stock: ${vars[0] ?? "inventory"}` : purpose === "OTP" ? "Your one-time code" : "A message from your restaurant";
      return { provider: "email", messageId: await this.email.send(row.recipient, subject, row.body) };
    }
    if (row.channel === "SMS") {
      if (purpose === "OTP") return this.sms.sendOtp({ to: row.recipient, otp: vars[0] ?? "", templateId: tpl.sms?.templateId });
      if (!tpl.sms?.templateId) {
        if (this.sms.live) throw new BadRequestException(`No DLT-approved SMS template configured for ${purpose}`);
        return this.sms.sendTemplate({ to: row.recipient, templateId: `unconfigured-${purpose}`, vars: { message: row.body } });
      }
      const names = tpl.sms.varNames?.length ? tpl.sms.varNames : MESSAGING_PURPOSE_VARS[purpose].map((_, i) => `var${i + 1}`);
      const mapped = Object.fromEntries(names.map((n, i) => [n, vars[i] ?? ""]));
      return this.sms.sendTemplate({ to: row.recipient, templateId: tpl.sms.templateId, vars: mapped, senderId: cfg?.smsSenderId ?? undefined });
    }
    // WhatsApp: only pre-approved templates may be sent to customers outside a 24h session.
    if (!tpl.whatsapp?.name) {
      if (this.whatsapp.live) throw new BadRequestException(`No approved WhatsApp template configured for ${purpose}`);
    }
    return this.whatsapp.sendTemplate({
      to: row.recipient,
      phoneNumberId: cfg?.whatsappPhoneNumberId ?? undefined,
      template: tpl.whatsapp?.name ?? `unconfigured_${purpose.toLowerCase()}`,
      language: tpl.whatsapp?.language ?? "en",
      bodyParams: vars,
      buttonParam: purpose === "OTP" ? vars[0] : undefined,
    });
  }

  /**
   * One dispatcher pass: claim due rows with SKIP LOCKED (safe across replicas),
   * honour each tenant's per-minute budget, send, and release the remainder.
   */
  async processOutbox(batch = 100): Promise<{ sent: number; deferred: number }> {
    return runUnscoped(async () => {
      const claimed = await this.prisma.$queryRaw<MessageOutbox[]>`
        UPDATE message_outbox SET status = 'SENDING', attempts = attempts + 1, "updatedAt" = now()
        WHERE id IN (
          SELECT id FROM message_outbox WHERE status = 'QUEUED' AND "nextAttemptAt" <= now()
          ORDER BY "createdAt" LIMIT ${batch} FOR UPDATE SKIP LOCKED
        ) RETURNING *`;
      let sent = 0;
      let deferred = 0;
      const byTenant = new Map<string, MessageOutbox[]>();
      for (const r of claimed) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
      for (const [tenantId, rows] of byTenant) {
        const cfg = await this.rawConfig(tenantId);
        const perMinute = cfg?.ratePerMinute ?? 60;
        const recent = await this.prisma.messageOutbox.count({ where: { tenantId, sentAt: { gt: new Date(Date.now() - 60_000) } } });
        let budget = Math.max(0, perMinute - recent);
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        for (const row of rows) {
          if (budget <= 0) {
            await this.prisma.messageOutbox.update({
              where: { id: row.id },
              data: { status: "QUEUED", attempts: { decrement: 1 }, nextAttemptAt: new Date(Date.now() + 10_000) },
            });
            deferred++;
            continue;
          }
          budget--;
          const done = await this.deliver(row);
          if (done.status === "SENT") sent++;
        }
      }
      return { sent, deferred };
    });
  }

  // ---------- Delivery receipts ----------

  /** Apply a provider delivery receipt; statuses only move forward. */
  async applyDelivery(providerMessageId: string, status: OutboxStatus, error?: string | null): Promise<number> {
    return runUnscoped(async () => {
      const rows = await this.prisma.messageOutbox.findMany({ where: { providerMessageId } });
      let n = 0;
      for (const r of rows) {
        if ((STATUS_RANK[status] ?? 0) <= (STATUS_RANK[r.status] ?? 0) && !(status === "FAILED" && r.status === "SENT")) continue;
        await this.prisma.messageOutbox.update({
          where: { id: r.id },
          data: {
            status,
            ...(status === "DELIVERED" || status === "READ" ? { deliveredAt: r.deliveredAt ?? new Date() } : {}),
            ...(error ? { error: error.slice(0, 300) } : {}),
          },
        });
        n++;
      }
      return n;
    });
  }

  /** WhatsApp Cloud webhook: statuses + inbound STOP opt-outs. */
  async handleWhatsAppWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!rawBody || !this.whatsapp.verifyWebhook(rawBody, signature)) throw new BadRequestException("Invalid signature");
    const body = JSON.parse(rawBody.toString("utf8")) as {
      entry?: { changes?: { value?: {
        metadata?: { phone_number_id?: string };
        statuses?: { id: string; status: string; errors?: { title?: string; message?: string }[] }[];
        messages?: { from: string; type?: string; text?: { body?: string }; button?: { text?: string } }[];
      } }[] }[];
    };
    let updated = 0;
    let optOuts = 0;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        for (const s of v.statuses ?? []) {
          const map: Record<string, OutboxStatus> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
          const st = map[s.status];
          if (st) updated += await this.applyDelivery(s.id, st, s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null);
        }
        for (const m of v.messages ?? []) {
          const text = (m.text?.body ?? m.button?.text ?? "").trim().toUpperCase();
          if (!/^(STOP|UNSUBSCRIBE|STOP PROMOTIONS)$/.test(text)) continue;
          optOuts += await this.optOutEverywhere(m.from, "WHATSAPP", "WHATSAPP_STOP", v.metadata?.phone_number_id);
        }
      }
    }
    return { ok: true, updated, optOuts };
  }

  /**
   * An inbound STOP names a phone, not a tenant. If the receiving number belongs
   * to one tenant, opt out there; on the shared platform number, opt out of every
   * tenant that knows this customer.
   */
  private async optOutEverywhere(from: string, channel: "WHATSAPP" | "SMS", source: string, phoneNumberId?: string) {
    const phone = nationalPhone(from);
    return runUnscoped(async () => {
      const owner = phoneNumberId ? await this.prisma.messagingConfig.findFirst({ where: { whatsappPhoneNumberId: phoneNumberId } }) : null;
      const tenantIds = owner
        ? [owner.tenantId]
        : [...new Set((await this.prisma.customer.findMany({ where: { phone: { endsWith: phone } }, select: { tenantId: true } })).map((c) => c.tenantId))];
      for (const tenantId of tenantIds) await this.optOut(tenantId, { phone, channel }, source);
      return tenantIds.length;
    });
  }

  /**
   * MSG91 delivery report webhook (unsigned by MSG91 — authenticated by the
   * secret token in our callback URL). Body: [{ requestId, report: [{ number, status, desc }] }].
   */
  async handleMsg91Report(body: unknown) {
    const items = Array.isArray(body) ? body : typeof body === "object" && body && "data" in body ? parseMaybeJson((body as { data: unknown }).data) : [];
    let updated = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const requestId = String((item as { requestId?: string }).requestId ?? "");
      for (const rep of ((item as { report?: { status?: string | number; desc?: string }[] }).report ?? [])) {
        const code = Number(rep.status);
        const desc = String(rep.desc ?? "").toUpperCase();
        const st: OutboxStatus | null = code === 1 || desc === "DELIVERED" ? "DELIVERED" : code === 2 || /FAIL|REJECT|NDNC|BLOCK/.test(desc) ? "FAILED" : null;
        if (requestId && st) updated += await this.applyDelivery(requestId, st, st === "FAILED" ? rep.desc ?? "failed" : null);
      }
    }
    return { ok: true, updated };
  }

  // ---------- Reads ----------

  async outbox(user: AuthUser, campaignId?: string): Promise<OutboxMessageDto[]> {
    const rows = await this.prisma.messageOutbox.findMany({
      where: { tenantId: user.tenantId, ...(campaignId ? { campaignId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose as MessagingPurpose,
      channel: r.channel as MessagingChannel,
      recipient: maskRecipient(r.recipient),
      status: r.status as OutboxStatus,
      provider: r.provider,
      error: r.error,
      attempts: r.attempts,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    }));
  }

  async campaignStats(user: AuthUser, campaignId: string): Promise<CampaignStatsDto> {
    const grouped = await this.prisma.messageOutbox.groupBy({
      by: ["status"],
      where: { tenantId: user.tenantId, campaignId },
      _count: { _all: true },
    });
    const stats: CampaignStatsDto = { QUEUED: 0, SENDING: 0, SENT: 0, DELIVERED: 0, READ: 0, FAILED: 0, SKIPPED: 0, total: 0 };
    for (const g of grouped) {
      stats[g.status as OutboxStatus] = g._count._all;
      stats.total += g._count._all;
    }
    return stats;
  }
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return [];
  }
}

function maskRecipient(r: string): string {
  if (r.includes("@")) return r.replace(/^(.).*(@.*)$/, "$1***$2");
  return r.length > 4 ? `${"•".repeat(r.length - 4)}${r.slice(-4)}` : r;
}
