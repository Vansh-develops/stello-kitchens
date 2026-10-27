import { Logger } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Where uploaded media (menu photos) lives. Two adapters:
 *  - LocalDiskStorage — files under MEDIA_DIR, served by the API at /api/v1/media/<key>
 *  - S3Storage — any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, DO Spaces),
 *    selected when S3_BUCKET + credentials are set. No SDK: requests are signed
 *    with AWS Signature V4 directly.
 */
export interface MediaStorage {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<{ url: string }>;
  remove(key: string): Promise<void>;
  /** The storage key for a URL this storage issued, or null for foreign URLs. */
  keyFromUrl(url: string): string | null;
  /** Local adapter only: read a stored object back for the public media route. */
  read?(key: string): Promise<Buffer | null>;
}

export const MEDIA_STORAGE = Symbol("MEDIA_STORAGE");

/** Keys are generated server-side; this guards the public read route anyway. */
export const SAFE_KEY = /^[a-z]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/;

export class LocalDiskStorage implements MediaStorage {
  readonly name = "local";
  private readonly root: string;

  constructor(
    dir: string,
    private readonly publicBase = "/api/v1/media",
  ) {
    this.root = resolve(dir);
  }

  private pathFor(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error("Invalid media key");
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error("Invalid media key");
    return full;
  }

  async put(key: string, body: Buffer): Promise<{ url: string }> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
    return { url: `${this.publicBase}/${key}` };
  }

  async remove(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => undefined);
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      return null;
    }
  }

  keyFromUrl(url: string): string | null {
    const prefix = `${this.publicBase}/`;
    if (!url.startsWith(prefix)) return null;
    const key = url.slice(prefix.length);
    return SAFE_KEY.test(key) ? key : null;
  }
}

export interface S3Config {
  endpoint: string; // e.g. https://s3.ap-south-1.amazonaws.com or https://<acct>.r2.cloudflarestorage.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string; // where objects are readable, e.g. https://cdn.example.com
}

export class S3Storage implements MediaStorage {
  readonly name = "s3";
  constructor(
    private readonly cfg: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<{ url: string }> {
    await this.send("PUT", key, body, { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" });
    return { url: `${this.cfg.publicBaseUrl.replace(/\/$/, "")}/${key}` };
  }

  async remove(key: string): Promise<void> {
    await this.send("DELETE", key, Buffer.alloc(0), {});
  }

  keyFromUrl(url: string): string | null {
    const prefix = `${this.cfg.publicBaseUrl.replace(/\/$/, "")}/`;
    if (!url.startsWith(prefix)) return null;
    const key = url.slice(prefix.length);
    return SAFE_KEY.test(key) ? key : null;
  }

  /** Path-style request signed with AWS SigV4 (works across S3-compatible providers). */
  private async send(method: "PUT" | "DELETE", key: string, body: Buffer, extra: Record<string, string>) {
    const endpoint = new URL(this.cfg.endpoint);
    const path = `/${encodeURIComponent(this.cfg.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const headers: Record<string, string> = {
      host: endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extra,
    };
    const signedNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = signedNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join("");
    const signedHeaders = signedNames.join(";");
    const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
    const hmac = (k: Buffer | string, v: string) => createHmac("sha256", k).update(v).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, day), this.cfg.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const { host: _host, ...sendHeaders } = headers;
    const res = await this.fetchImpl(`${endpoint.origin}${path}`, {
      method,
      headers: { ...sendHeaders, authorization },
      body: method === "PUT" ? new Uint8Array(body) : undefined,
    });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      throw new Error(`S3 ${method} failed (${res.status})`);
    }
  }
}

/** Real S3-compatible storage when configured; local disk otherwise (dev/tests). */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): MediaStorage {
  const { S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
    const region = env.S3_REGION || "auto";
    const endpoint = env.S3_ENDPOINT || `https://s3.${region}.amazonaws.com`;
    return new S3Storage({
      endpoint,
      region,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      publicBaseUrl: env.S3_PUBLIC_BASE_URL || `${endpoint.replace(/\/$/, "")}/${S3_BUCKET}`,
    });
  }
  new Logger("Media").log("S3 not configured — storing uploads on local disk");
  return new LocalDiskStorage(env.MEDIA_DIR || "./uploads");
}
