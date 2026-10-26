/**
 * Minimal JSON-over-HTTP helper shared by the real provider adapters (Razorpay,
 * MSG91, WhatsApp Cloud, Masters India). Uses the runtime's fetch so tests can
 * intercept every call with an undici MockAgent — no adapter talks to the
 * network any other way.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null, // null = transport failure / timeout (outcome unknown)
    message: string,
    readonly body?: unknown,
  ) {
    super(`${provider}: ${message}`);
  }
  /** True when the request may or may not have taken effect at the provider. */
  get uncertain(): boolean {
    return this.status === null || this.status >= 500;
  }
}

export interface HttpRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export async function httpJson<T = unknown>(provider: string, url: string, req: HttpRequest = {}): Promise<{ status: number; body: T }> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(u, {
      method: req.method ?? (req.body === undefined ? "GET" : "POST"),
      headers: { Accept: "application/json", ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}), ...req.headers },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new ProviderHttpError(provider, null, `request failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — keep the text */
  }
  if (!res.ok) {
    const detail = typeof body === "object" && body ? JSON.stringify(body).slice(0, 300) : String(text).slice(0, 300);
    throw new ProviderHttpError(provider, res.status, `HTTP ${res.status} ${detail}`, body);
  }
  return { status: res.status, body: body as T };
}

/** Indian mobile → E.164 digits without '+', as MSG91 and WhatsApp expect ("919876543210"). */
export function toMsisdn(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}
