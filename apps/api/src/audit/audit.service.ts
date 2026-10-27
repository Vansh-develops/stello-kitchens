import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { AuditFacetsDto, AuditLogDto, AuditPageDto, AuditQueryInput, AuthUser } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";

type Row = Prisma.AuditLogGetPayload<{ include: { user: { select: { id: true; name: true; email: true } } } }>;

/** Opaque keyset cursor: base64url("<createdAt ISO>|<id>"). */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = new Date(iso ?? "");
  if (!id || Number.isNaN(createdAt.getTime())) throw new BadRequestException("Invalid cursor");
  return { createdAt, id };
}

/**
 * Read side of the tenant audit trail. Newest first, keyset-paginated on
 * (createdAt, id) so pages stay stable while new entries arrive.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async page(user: AuthUser, q: AuditQueryInput): Promise<AuditPageDto> {
    const and: Prisma.AuditLogWhereInput[] = [{ tenantId: user.tenantId }];
    if (q.actorId) and.push({ userId: q.actorId });
    if (q.action) and.push({ action: q.action });
    if (q.entity) and.push({ entity: q.entity });
    if (q.entityId) and.push({ entityId: q.entityId });
    if (q.from) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00`) } });
    if (q.to) and.push({ createdAt: { lte: new Date(`${q.to}T23:59:59.999`) } });
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      and.push({ OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] });
    }
    const rows = await this.prisma.auditLog.findMany({
      where: { AND: and },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const items = rows.slice(0, q.limit);
    return {
      items: items.map(toDto),
      nextCursor: rows.length > q.limit ? encodeCursor(items[items.length - 1]) : null,
    };
  }

  async one(user: AuthUser, id: string): Promise<AuditLogDto> {
    const row = await this.prisma.auditLog.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (!row) throw new NotFoundException("Audit entry not found");
    return toDto(row);
  }

  async facets(user: AuthUser): Promise<AuditFacetsDto> {
    const [actions, entities, actors] = await Promise.all([
      this.prisma.auditLog.groupBy({ by: ["action"], where: { tenantId: user.tenantId }, orderBy: { action: "asc" } }),
      this.prisma.auditLog.groupBy({ by: ["entity"], where: { tenantId: user.tenantId }, orderBy: { entity: "asc" } }),
      this.prisma.user.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
    ]);
    return { actions: actions.map((a) => a.action), entities: entities.map((e) => e.entity), actors };
  }
}

function toDto(row: Row): AuditLogDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    actor: row.user ? { id: row.user.id, name: row.user.name, email: row.user.email } : null,
    data: row.data ?? null,
  };
}
