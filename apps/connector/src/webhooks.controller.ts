import { InjectQueue } from "@nestjs/bullmq";
import { Body, Controller, Headers, HttpCode, InternalServerErrorException, Logger, Param, Post, Req } from "@nestjs/common";
import { Queue } from "bullmq";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { AdapterRegistry } from "./adapters/registry";
import { INGEST_QUEUE } from "./ingest.processor";

/**
 * Inbound aggregator webhooks. Each provider POSTs its own order shape; we parse
 * to canonical and enqueue for reliable relay, then ACK fast — aggregators expect
 * a quick 2xx and will retry (or auto-reject) if we're slow.
 */
@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly registry: AdapterRegistry,
    @InjectQueue(INGEST_QUEUE) private readonly queue: Queue,
  ) {}

  @Post(":platform/order")
  @HttpCode(202)
  async order(
    @Param("platform") platform: string,
    @Body() payload: unknown,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    const adapter = this.registry.get(platform);
    // Authenticate the raw bytes before doing anything else — an unsigned or
    // tampered delivery is rejected with 401 and never parsed or enqueued.
    const rawBody = req.rawBody;
    if (!rawBody) throw new InternalServerErrorException("Raw body unavailable for signature verification");
    adapter.verifySignature(rawBody, headers);
    const order = adapter.parseOrder(payload);
    const job = await this.queue.add("forward", order, {
      jobId: `${order.platform}__${order.externalOrderId}`, // dedupe re-deliveries (no ':' allowed)
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
    this.logger.log(`[${order.platform}] queued ${order.externalOrderId} (${order.items.length} items) as job ${job.id}`);
    return { accepted: true, externalOrderId: order.externalOrderId, items: order.items.length };
  }
}
