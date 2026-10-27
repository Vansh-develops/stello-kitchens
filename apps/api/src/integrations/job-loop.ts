import { Logger } from "@nestjs/common";
import { runUnscoped } from "../common/tenant-context";

/**
 * Background loops for provider reconciliation (refund recovery, outbox
 * dispatch, low-stock sweep). Ticks are safe to run on several API replicas at
 * once: every job claims its rows with a conditional update or
 * `FOR UPDATE SKIP LOCKED`, never with an in-process lock. Disabled under tests
 * and when INTEGRATION_JOBS=off — tests call the tick functions directly.
 */
export function jobsEnabled(): boolean {
  return process.env.INTEGRATION_JOBS !== "off" && !process.env.VITEST;
}

export function startJobLoop(name: string, intervalMs: number, tick: () => Promise<unknown>): () => void {
  if (!jobsEnabled()) return () => undefined;
  const logger = new Logger(`Job:${name}`);
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap ticks of the same job in one process
    running = true;
    void runUnscoped(tick)
      .catch((e) => logger.error((e as Error).message))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
