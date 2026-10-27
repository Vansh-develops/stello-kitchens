import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import {
  API_KEY_PREFIX,
  missingPermissions,
  type ApiKeyCreateInput,
  type ApiKeyCreatedDto,
  type ApiKeyDto,
  type AuthUser,
} from "@stello/shared";
import type { ApiKey } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { hashToken } from "../common/token";

/** Don't write lastUsedAt more often than this per key (hot path). */
const LAST_USED_GRANULARITY_MS = 60_000;

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

/**
 * Tenant API keys: `stk_<8-char id>_<43-char secret>`. Only a sha256 of the full
 * key is stored (the secret has 256 bits of entropy, so a fast hash is the
 * right tool); the prefix lets owners recognise a key in the UI. A key carries
 * explicit permission keys (never "*", never beyond its creator's) and an
 * optional outlet allow-list, and authenticates as a non-person principal.
 */
@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser): Promise<ApiKeyDto[]> {
    const rows = await this.prisma.apiKey.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
    return rows.map(toDto);
  }

  async create(user: AuthUser, input: ApiKeyCreateInput): Promise<ApiKeyCreatedDto> {
    const missing = missingPermissions(user.permissions, input.permissions);
    if (missing.length) throw new ForbiddenException(`You can't grant permissions you don't hold: ${missing.join(", ")}`);
    let outletIds: string[] | null = null;
    if (input.outletIds && input.outletIds.length) {
      const owned = await this.prisma.outlet.count({ where: { tenantId: user.tenantId, id: { in: input.outletIds } } });
      if (owned !== new Set(input.outletIds).size) throw new BadRequestException("Unknown outlet in outletIds");
      outletIds = [...new Set(input.outletIds)];
    }
    const id = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8);
    const key = `${API_KEY_PREFIX}${id}_${randomBytes(32).toString("base64url")}`;
    const row = await this.prisma.apiKey.create({
      data: {
        tenantId: user.tenantId,
        name: input.name,
        prefix: `${API_KEY_PREFIX}${id}`,
        keyHash: hashToken(key),
        permissions: [...new Set(input.permissions)],
        outletIds: outletIds ?? undefined,
        createdById: user.apiKeyId ? null : user.id,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      },
    });
    await this.audit(user, "API_KEY_CREATED", row.id, { name: row.name, permissions: row.permissions });
    return { ...toDto(row), key };
  }

  async revoke(user: AuthUser, id: string): Promise<ApiKeyDto> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!row) throw new NotFoundException("API key not found");
    const updated = row.revokedAt
      ? row
      : await this.prisma.apiKey.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    await this.audit(user, "API_KEY_REVOKED", row.id, { name: row.name });
    return toDto(updated);
  }

  /** Resolve a raw key to a principal, or null. Runs before any tenant context exists. */
  async authenticate(raw: string): Promise<AuthUser | null> {
    if (!raw.startsWith(API_KEY_PREFIX) || raw.length > 200) return null;
    const row = await runUnscoped(() => this.prisma.apiKey.findUnique({ where: { keyHash: hashToken(raw) } }));
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date())) return null;
    const tenant = await runUnscoped(() => this.prisma.tenant.findUnique({ where: { id: row.tenantId } }));
    if (!tenant || tenant.status === "SUSPENDED" || (tenant.status === "TRIAL" && tenant.trialEndsAt && tenant.trialEndsAt < new Date())) {
      return null;
    }
    const allowed = row.outletIds == null ? null : asStrings(row.outletIds);
    const outlets = await runUnscoped(() =>
      this.prisma.outlet.findMany({
        where: { tenantId: row.tenantId, ...(allowed ? { id: { in: allowed } } : {}) },
        select: { id: true },
      }),
    );
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS) {
      await runUnscoped(() => this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }));
    }
    return {
      id: `apikey:${row.id}`,
      apiKeyId: row.id,
      tenantId: row.tenantId,
      email: "",
      name: row.name,
      roleName: "API key",
      permissions: asStrings(row.permissions).filter((p) => p !== "*"),
      outletIds: outlets.map((o) => o.id),
      isPlatformAdmin: false,
    };
  }

  private audit(user: AuthUser, action: string, entityId: string, data: object) {
    return this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.apiKeyId ? null : user.id, action, entity: "api_key", entityId, data: data as never },
    });
  }
}

function toDto(row: ApiKey): ApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    permissions: asStrings(row.permissions),
    outletIds: row.outletIds == null ? null : asStrings(row.outletIds),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
