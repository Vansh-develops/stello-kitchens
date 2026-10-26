import { Logger } from "@nestjs/common";

/**
 * Post-commit order lifecycle signals for side effects that must never block or
 * fail an order (printing today). Emitters await listeners so effects are in
 * place when the request returns, but every listener error is logged and
 * swallowed — a jammed printer can't roll back a sale.
 *
 * A plain module-level bus rather than a constructor dependency, so the order
 * paths (POS, scan, aggregator, settle, cancel) emit without every caller and
 * test having to wire a printing service.
 */
export type OrderEvent =
  | { type: "kot.created"; tenantId: string; outletId: string; orderId: string; userId: string | null }
  | { type: "order.settled"; tenantId: string; outletId: string; orderId: string; userId: string | null }
  | { type: "order.cancelled"; tenantId: string; outletId: string; orderId: string; userId: string | null };

type Listener = (event: OrderEvent) => Promise<void> | void;

const logger = new Logger("OrderEvents");
const listeners = new Set<Listener>();

export const orderEvents = {
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async emit(event: OrderEvent): Promise<void> {
    await Promise.all(
      [...listeners].map(async (l) => {
        try {
          await l(event);
        } catch (err) {
          logger.error(`${event.type} listener failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  },
};
