import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ConnectorIngestResult, MenuPushRowDto } from "@petpooja/shared";
import type { CanonicalOrder } from "./adapters/types";

/** Thin HTTP client for the main API's service-authenticated connector surface. */
@Injectable()
export class MainApiService {
  private readonly logger = new Logger(MainApiService.name);
  private readonly base: string;
  private readonly key: string;

  constructor(config: ConfigService) {
    this.base = config.get<string>("MAIN_API_URL") ?? "http://localhost:3001/api/v1";
    this.key = config.get<string>("CONNECTOR_KEY") ?? "dev-connector-key";
  }

  private async call<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", "x-connector-key": this.key, ...options.headers },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`main-api ${path} -> ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  ingest(order: CanonicalOrder): Promise<ConnectorIngestResult> {
    return this.call<ConnectorIngestResult>("/connector/ingest", {
      method: "POST",
      body: JSON.stringify(order),
    });
  }

  updateStatus(platform: string, externalOrderId: string, status: string) {
    return this.call(`/connector/orders/${platform}/${encodeURIComponent(externalOrderId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  }

  menuPush(platform: string, outletId: string): Promise<MenuPushRowDto[]> {
    return this.call<MenuPushRowDto[]>(`/connector/menu-push/${platform}?outletId=${outletId}`);
  }

  stockPush(platform: string, outletId: string): Promise<string[]> {
    return this.call<string[]>(`/connector/stock/${platform}?outletId=${outletId}`);
  }
}
