import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, type WebhookDelivery, type WebhookEndpoint } from "@prisma/client";
import {
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_SIGNATURE_HEADER,
  type AuthUser,
  type WebhookCreateInput,
  type WebhookCreatedDto,
  type WebhookDeliveryDto,
  type WebhookDto,
  type WebhookEventType,
  type WebhookUpdateInput,
} from "@stello/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { openSecret, sealSecret } from "../common/secret-box";
import { domainEvents, type DomainEvent } from "../events/domain-events";
import { assertPublicTarget, checkWebhookUrl, MAX_ATTEMPTS, newWebhookSecret, nextRetryDelay, signWebhook } from "./webhook-signing";

const PUBLIC_EVENTS = new Set<string>(WEBHOOK_EVENT_KEYS);
const SEND_TIMEOUT_MS = 10_000;
const LEASE_MS = 2 * 60_000; // a claimed delivery is invisible to other workers for this long
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

/**
 * Outbound webhooks. Domain events fan out to persisted delivery rows (one per
 * subscribed endpoint); a DB-backed worker claims due rows with
 * `FOR UPDATE SKIP LOCKED` (safe across API instances), POSTs the JSON body
 * signed with HMAC-SHA256, and retries failures with exponential backoff up to
 * MAX_ATTEMPTS before marking them FAILED. Every attempt is visible in the
 * delivery log; owners can test-send and manually redeliver.
 */
@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Webhooks");
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.unsubscribe = domainEvents.subscribe(async (e) => void (await this.onEvent(e)));
    if (this.workerEnabled()) {
      const every = Number(process.env.WEBHOOK_WORKER_INTERVAL_MS || 5000);
      this.timer = setInterval(() => void this.processDue(), every);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  private workerEnabled() {
    return process.env.NODE_ENV !== "test" && process.env.WEBHOOK_WORKER_DISABLED !== "true";
  }

  // ───────────── management ─────────────

  async list(user: AuthUser): Promise<WebhookDto[]> {
    const rows = await this.prisma.webhookEndpoint.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
    return rows.map(toDto);
  }

  async create(user: AuthUser, input: WebhookCreateInput): Promise<WebhookCreatedDto> {
    this.checkUrl(input.url);
    if (input.outletId) await this.assertOutlet(user, input.outletId);
    const secret = newWebhookSecret();
    const row = await this.prisma.webhookEndpoint.create({
      data: {
        tenantId: user.tenantId,
        outletId: input.outletId ?? null,
        url: input.url,
        description: input.description ?? null,
        secretEnc: sealSecret(secret),
        events: [...new Set(input.events)],
        isActive: input.isActive,
      },
    });
    await this.audit(user, "WEBHOOK_CREATED", row.id, { url: row.url, events: row.events });
    return { ...toDto(row), secret };
  }

  async update(user: AuthUser, id: string, input: WebhookUpdateInput): Promise<WebhookDto> {
    const row = await this.requireEndpoint(user, id);
    if (input.url) this.checkUrl(input.url);
    if (input.outletId) await this.assertOutlet(user, input.outletId);
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id: row.id },
      data: {
        url: input.url,
        description: input.description,
        events: input.events ? [...new Set(input.events)] : undefined,
        outletId: input.outletId === undefined ? undefined : input.outletId,
        isActive: input.isActive,
      },
    });
    await this.audit(user, "WEBHOOK_UPDATED", row.id, input as Prisma.InputJsonValue);
    return toDto(updated);
  }

  async rotateSecret(user: AuthUser, id: string): Promise<WebhookCreatedDto> {
    const row = await this.requireEndpoint(user, id);
    const secret = newWebhookSecret();
    const updated = await this.prisma.webhookEndpoint.update({ where: { id: row.id }, data: { secretEnc: sealSecret(secret) } });
    await this.audit(user, "WEBHOOK_SECRET_ROTATED", row.id, {});
    return { ...toDto(updated), secret };
  }

  async remove(user: AuthUser, id: string): Promise<{ id: string }> {
    const row = await this.requireEndpoint(user, id);
    await this.prisma.webhookEndpoint.delete({ where: { id: row.id } });
    await this.audit(user, "WEBHOOK_DELETED", row.id, { url: row.url });
    return { id: row.id };
  }

  async deliveries(user: AuthUser, endpointId: string, cursor?: string, limit = 50): Promise<{ items: WebhookDeliveryDto[]; nextCursor: string | null }> {
    await this.requireEndpoint(user, endpointId);
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { tenantId: user.tenantId, endpointId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit);
    return { items: items.map(deliveryDto), nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }

  /** Send a synthetic `webhook.test` event right now and return the attempt result. */
  async testSend(user: AuthUser, endpointId: string): Promise<WebhookDeliveryDto> {
    const endpoint = await this.requireEndpoint(user, endpointId);
    const eventId = `evt_${randomUUID()}`;
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        tenantId: user.tenantId,
        endpointId: endpoint.id,
        eventId,
        eventType: "webhook.test",
        payload: envelope({
          id: eventId,
          type: "webhook.test",
          tenantId: user.tenantId,
          outletId: endpoint.outletId,
          occurredAt: new Date().toISOString(),
          data: { message: "Test delivery from Stello Kitchens" },
        }) as Prisma.InputJsonValue,
        nextAttemptAt: null,
      },
    });
    return deliveryDto(await this.attempt(delivery.id));
  }

  async redeliver(user: AuthUser, deliveryId: string): Promise<WebhookDeliveryDto> {
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, tenantId: user.tenantId } });
    if (!d) throw new NotFoundException("Delivery not found");
    await this.prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "PENDING", nextAttemptAt: null } });
    return deliveryDto(await this.attempt(d.id));
  }

  // ───────────── fan-out ─────────────

  /** Domain event -> one PENDING delivery per matching active endpoint. */
  async onEvent(event: DomainEvent): Promise<number> {
    if (!PUBLIC_EVENTS.has(event.type)) return 0;
    const endpoints = await runUnscoped(() =>
      this.prisma.webhookEndpoint.findMany({ where: { tenantId: event.tenantId, isActive: true } }),
    );
    const targets = endpoints.filter(
      (e) => strings(e.events).includes(event.type) && (!e.outletId || e.outletId === event.outletId),
    );
    if (!targets.length) return 0;
    const data = await this.enrich(event);
    const payload = envelope({ ...event, data }) as Prisma.InputJsonValue;
    await runUnscoped(() =>
      this.prisma.webhookDelivery.createMany({
        data: targets.map((e) => ({
          tenantId: event.tenantId,
          endpointId: e.id,
          eventId: event.id,
          eventType: event.type,
          payload,
          nextAttemptAt: new Date(),
        })),
      }),
    );
    if (this.workerEnabled()) setImmediate(() => void this.processDue());
    return targets.length;
  }

  /** Order events carry a snapshot of the order so receivers rarely need to call back. */
  private async enrich(event: DomainEvent): Promise<Record<string, unknown>> {
    const orderId = typeof event.data.orderId === "string" ? event.data.orderId : null;
    if (!orderId || !event.type.startsWith("order.")) return event.data;
    const order = await runUnscoped(() =>
      this.prisma.order.findFirst({
        where: { id: orderId, tenantId: event.tenantId },
        include: { items: { select: { itemId: true, itemName: true, quantity: true, unitPrice: true, lineTotal: true } } },
      }),
    );
    if (!order) return event.data;
    return {
      ...event.data,
      order: {
        id: order.id,
        outletId: order.outletId,
        status: order.status,
        orderType: order.orderType,
        billNumber: order.billNumber,
        subtotal: Number(order.subtotal),
        discountAmount: Number(order.discountAmount),
        taxAmount: Number(order.taxAmount),
        total: Number(order.total),
        createdAt: order.createdAt.toISOString(),
        items: order.items.map((i) => ({ ...i, unitPrice: Number(i.unitPrice), lineTotal: Number(i.lineTotal) })),
      },
    };
  }

  // ───────────── delivery worker ─────────────

  /** Claim and send due deliveries. Returns how many were attempted. */
  async processDue(batch = 20): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = await runUnscoped(() =>
        this.prisma.$queryRaw<{ id: string }[]>`
          UPDATE webhook_deliveries SET "nextAttemptAt" = ${new Date(Date.now() + LEASE_MS)}
          WHERE id IN (
            SELECT id FROM webhook_deliveries
            WHERE status = 'PENDING' AND "nextAttemptAt" IS NOT NULL AND "nextAttemptAt" <= ${new Date()}
            ORDER BY "nextAttemptAt" ASC
            LIMIT ${batch}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id`,
      );
      for (const { id } of claimed) await this.attempt(id);
      return claimed.length;
    } catch (err) {
      this.log.warn(`worker tick failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** One HTTP attempt; records the outcome and schedules a retry if needed. */
  async attempt(deliveryId: string): Promise<WebhookDelivery> {
    const d = await runUnscoped(() =>
      this.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { endpoint: true } }),
    );
    const attempts = d.attempts + 1;
    if (!d.endpoint.isActive && d.eventType !== "webhook.test") {
      return this.finish(d.id, { status: "FAILED", attempts, nextAttemptAt: null, lastError: "Endpoint disabled" });
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    const started = Date.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      await assertPublicTarget(d.endpoint.url);
      const res = await fetch(d.endpoint.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "user-agent": "Stello-Webhooks/1.0",
          "stello-event": d.eventType,
          "stello-delivery": d.id,
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook(openSecret(d.endpoint.secretEnc), body, ts),
        },
        body,
      });
      statusCode = res.status;
      await res.arrayBuffer().catch(() => undefined); // drain
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? (err.name === "TimeoutError" ? "Timed out" : err.message) : String(err);
    }
    const durationMs = Date.now() - started;
    if (!error) {
      return this.finish(d.id, { status: "SUCCEEDED", attempts, lastStatusCode: statusCode, lastError: null, durationMs, deliveredAt: new Date(), nextAttemptAt: null });
    }
    const delay = d.eventType === "webhook.test" ? null : nextRetryDelay(attempts);
    return this.finish(d.id, {
      status: delay === null ? "FAILED" : "PENDING",
      attempts,
      lastStatusCode: statusCode,
      lastError: error.slice(0, 500),
      durationMs,
      nextAttemptAt: delay === null ? null : new Date(Date.now() + delay),
    });
  }

  private finish(id: string, data: Prisma.WebhookDeliveryUpdateInput) {
    return runUnscoped(() => this.prisma.webhookDelivery.update({ where: { id }, data }));
  }

  // ───────────── helpers ─────────────

  private checkUrl(url: string) {
    const problem = checkWebhookUrl(url);
    if (problem) throw new BadRequestException(problem);
  }

  private async assertOutlet(user: AuthUser, outletId: string) {
    const ok = await this.prisma.outlet.findFirst({ where: { id: outletId, tenantId: user.tenantId }, select: { id: true } });
    if (!ok) throw new BadRequestException("Unknown outlet");
  }

  private async requireEndpoint(user: AuthUser, id: string): Promise<WebhookEndpoint> {
    const row = await this.prisma.webhookEndpoint.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!row) throw new NotFoundException("Webhook not found");
    return row;
  }

  private audit(user: AuthUser, action: string, entityId: string, data: Prisma.InputJsonValue) {
    return this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.apiKeyId ? null : user.id, action, entity: "webhook", entityId, data },
    });
  }
}

export { MAX_ATTEMPTS };

function envelope(e: DomainEvent) {
  return { id: e.id, type: e.type, createdAt: e.occurredAt, tenantId: e.tenantId, outletId: e.outletId, data: e.data };
}

function toDto(row: WebhookEndpoint): WebhookDto {
  let preview = "whsec_…";
  try {
    preview = `${openSecret(row.secretEnc).slice(0, 10)}…`;
  } catch {
    /* unreadable with the current key */
  }
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: strings(row.events) as WebhookEventType[],
    outletId: row.outletId,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    secretPreview: preview,
  };
}

function deliveryDto(d: WebhookDelivery): WebhookDeliveryDto {
  return {
    id: d.id,
    endpointId: d.endpointId,
    eventType: d.eventType,
    eventId: d.eventId,
    status: d.status as WebhookDeliveryDto["status"],
    attempts: d.attempts,
    nextAttemptAt: d.status === "PENDING" ? (d.nextAttemptAt?.toISOString() ?? null) : null,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    durationMs: d.durationMs,
    createdAt: d.createdAt.toISOString(),
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    payload: d.payload,
  };
}
