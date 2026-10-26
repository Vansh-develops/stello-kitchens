import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";

/**
 * Lightweight in-process domain-event bus. Services call `emitDomainEvent(...)`
 * AFTER their transaction commits (one line, no constructor changes), and
 * subscribers (webhooks, the low-stock watcher) react asynchronously so the
 * request path never waits on them or fails because of them.
 *
 * It is deliberately not durable: durability lives in the subscribers (e.g.
 * webhook deliveries are persisted rows that are retried with backoff).
 */
export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  tenantId: string;
  outletId: string | null;
  occurredAt: string;
  data: T;
}

type Handler = (event: DomainEvent) => void | Promise<void>;

class DomainEventBus {
  private readonly log = new Logger("DomainEvents");
  private readonly handlers = new Set<Handler>();
  private readonly pending = new Set<Promise<void>>();

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit<T extends Record<string, unknown>>(type: string, tenantId: string, outletId: string | null, data: T): DomainEvent<T> {
    const event: DomainEvent<T> = { id: `evt_${randomUUID()}`, type, tenantId, outletId, occurredAt: new Date().toISOString(), data };
    for (const handler of this.handlers) {
      const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => handler(event as DomainEvent))
        .catch((err) => this.log.warn(`${type} handler failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
    return event;
  }

  /** Resolves once every in-flight handler (including ones they trigger) settles. Tests use this. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}

export const domainEvents = new DomainEventBus();

export function emitDomainEvent(type: string, tenantId: string, outletId: string | null, data: Record<string, unknown>) {
  return domainEvents.emit(type, tenantId, outletId, data);
}
