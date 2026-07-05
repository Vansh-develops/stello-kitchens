import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { CanonicalOrder } from "./adapters/types";
import { MainApiService } from "./main-api.service";

export const INGEST_QUEUE = "ingest";

/**
 * Forwards a canonical order to the main API. Runs on a BullMQ worker so a main-API
 * blip (or the 99.999% SLA gap) becomes a retry with backoff, not a lost order.
 */
@Processor(INGEST_QUEUE)
export class IngestProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestProcessor.name);

  constructor(private readonly mainApi: MainApiService) {
    super();
  }

  async process(job: Job<CanonicalOrder>) {
    const order = job.data;
    const result = await this.mainApi.ingest(order);
    this.logger.log(
      `[${order.platform}] ${order.externalOrderId} → order ${result.orderId ?? "none"} ` +
        `(matched ${result.matched}, unmatched ${result.unmatched.length}${result.duplicate ? ", duplicate" : ""})`,
    );
    return result;
  }
}
