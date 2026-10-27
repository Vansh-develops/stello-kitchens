import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  CreateStockCountInput,
  MaterialUnit,
  StockCountDto,
  StockCountEntriesInput,
  StockCountSummaryDto,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { D, assertOutlet, nextDocNumber, round2, round3 } from "./procurement.common";

const OPEN = ["COUNTING", "SUBMITTED"];

/**
 * Stocktake. Expected quantities (and unit costs) are frozen when the count
 * starts; the physical count is taken as of that moment. Posting applies
 * `counted − frozen expected` as a *delta* under a row lock, so sales that
 * deplete stock while the count is in progress are preserved rather than
 * overwritten by an absolute "set stock to N".
 */
@Injectable()
export class StocktakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async categories(user: AuthUser, outletId: string): Promise<string[]> {
    assertOutlet(user, outletId);
    const rows = await this.prisma.materialPlanning.findMany({
      where: { tenantId: user.tenantId, outletId, category: { not: null } },
      select: { category: true },
      distinct: ["category"],
    });
    return rows.map((r) => r.category!).sort((a, b) => a.localeCompare(b));
  }

  async list(user: AuthUser, outletId: string): Promise<StockCountSummaryDto[]> {
    assertOutlet(user, outletId);
    const counts = await this.prisma.stockCount.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { startedAt: "desc" },
      take: 100,
      include: { lines: { select: { countedQty: true } } },
    });
    return counts.map((c) => this.toSummary(c));
  }

  async create(user: AuthUser, outletId: string, input: CreateStockCountInput) {
    assertOutlet(user, outletId);
    const category = input.scope === "CATEGORY" ? input.category?.trim() : null;
    if (input.scope === "CATEGORY" && !category) throw new BadRequestException("Pick a category to count");

    const count = await this.prisma.$transaction(async (tx) => {
      const countNumber = await nextDocNumber(tx, outletId, "SC", () => tx.stockCount.count({ where: { outletId } }));
      // One open count per scope: a full count excludes every other open count.
      const clash = await tx.stockCount.findFirst({
        where: {
          tenantId: user.tenantId,
          outletId,
          status: { in: OPEN },
          ...(category ? { OR: [{ scope: "FULL" }, { category }] } : {}),
        },
      });
      if (clash) throw new BadRequestException(`${clash.countNumber} is still open for an overlapping scope`);

      const materials = await tx.rawMaterial.findMany({
        where: {
          tenantId: user.tenantId,
          outletId,
          deletedAt: null,
          ...(category ? { planning: { category } } : {}),
        },
        orderBy: { name: "asc" },
      });
      if (!materials.length) throw new BadRequestException("No materials in this scope");
      return tx.stockCount.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          countNumber,
          scope: input.scope,
          category,
          note: input.note ?? null,
          startedById: user.id,
          lines: {
            create: materials.map((m) => ({
              tenantId: user.tenantId,
              rawMaterialId: m.id,
              materialName: m.name,
              unit: m.unit,
              expectedQty: m.stockQty,
              unitCost: m.costPerUnit,
            })),
          },
        },
      });
    });
    return { id: count.id, countNumber: count.countNumber };
  }

  async get(user: AuthUser, outletId: string, id: string): Promise<StockCountDto> {
    assertOutlet(user, outletId);
    const c = await this.prisma.stockCount.findFirst({
      where: { id, tenantId: user.tenantId, outletId },
      include: { lines: { orderBy: { materialName: "asc" }, include: { material: { include: { planning: true } } } } },
    });
    if (!c) throw new NotFoundException("Stock count not found");

    // Net ledger movement since the freeze (excluding this count's own adjustments).
    const moved = await this.prisma.stockMovement.groupBy({
      by: ["rawMaterialId"],
      where: {
        tenantId: user.tenantId,
        outletId,
        rawMaterialId: { in: c.lines.map((l) => l.rawMaterialId) },
        createdAt: { gt: c.startedAt },
        NOT: { refType: "stocktake", refId: c.id },
      },
      _sum: { quantity: true },
    });
    const movedBy = new Map(moved.map((m) => [m.rawMaterialId, D(m._sum.quantity)]));

    const lines = c.lines.map((l) => ({
      id: l.id,
      rawMaterialId: l.rawMaterialId,
      materialName: l.materialName,
      unit: l.unit as MaterialUnit,
      category: l.material.planning?.category ?? null,
      expectedQty: D(l.expectedQty),
      countedQty: l.countedQty === null ? null : D(l.countedQty),
      varianceQty: l.varianceQty === null ? null : D(l.varianceQty),
      varianceValue: l.varianceValue === null ? null : D(l.varianceValue),
      unitCost: D(l.unitCost),
      movedSinceFreeze: c.status === "POSTED" ? 0 : round3(movedBy.get(l.rawMaterialId) ?? 0),
      note: l.note,
    }));
    const values = lines.map((l) => l.varianceValue ?? 0);
    return {
      ...this.toSummary(c),
      note: c.note,
      lines,
      shrinkageValue: round2(values.filter((v) => v < 0).reduce((s, v) => s + v, 0)),
      surplusValue: round2(values.filter((v) => v > 0).reduce((s, v) => s + v, 0)),
    };
  }

  /** Save count sheet entries (batch, so a phone can sync a page at a time). */
  async enterCounts(user: AuthUser, outletId: string, id: string, input: StockCountEntriesInput) {
    assertOutlet(user, outletId);
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lockCount(tx, user, outletId, id);
      if (!OPEN.includes(c.status)) throw new BadRequestException(`Count is ${c.status.toLowerCase()}`);
      const lines = await tx.stockCountLine.findMany({ where: { stockCountId: id } });
      const byId = new Map(lines.map((l) => [l.id, l]));
      const now = new Date();
      for (const e of input.entries) {
        const line = byId.get(e.lineId);
        if (!line) throw new BadRequestException("Line does not belong to this count");
        const variance = e.countedQty === null ? null : round3(e.countedQty - D(line.expectedQty));
        await tx.stockCountLine.update({
          where: { id: line.id },
          data: {
            countedQty: e.countedQty,
            countedAt: e.countedQty === null ? null : now,
            countedById: e.countedQty === null ? null : user.id,
            note: e.note === undefined ? undefined : e.note,
            varianceQty: variance,
            varianceValue: variance === null ? null : round2(variance * D(line.unitCost)),
          },
        });
      }
    });
    return { id };
  }

  async submit(user: AuthUser, outletId: string, id: string) {
    assertOutlet(user, outletId);
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockCount(tx, user, outletId, id);
      if (c.status !== "COUNTING") throw new BadRequestException(`Count is ${c.status.toLowerCase()}`);
      const counted = await tx.stockCountLine.count({ where: { stockCountId: id, countedQty: { not: null } } });
      if (!counted) throw new BadRequestException("Count at least one material before submitting");
      await tx.stockCount.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
      return { id, status: "SUBMITTED" };
    });
  }

  async cancel(user: AuthUser, outletId: string, id: string) {
    assertOutlet(user, outletId);
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockCount(tx, user, outletId, id);
      if (!OPEN.includes(c.status)) throw new BadRequestException(`Count is ${c.status.toLowerCase()}`);
      await tx.stockCount.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      return { id, status: "CANCELLED" };
    });
  }

  /**
   * Post variances as ADJUSTMENT movements (approval permission). Uncounted
   * lines are left untouched. Each material is row-locked and adjusted by the
   * variance delta at its current weighted-average cost.
   */
  async post(user: AuthUser, outletId: string, id: string) {
    assertOutlet(user, outletId);
    const result = await this.prisma.$transaction(async (tx) => {
      const c = await this.lockCount(tx, user, outletId, id);
      if (!OPEN.includes(c.status)) throw new BadRequestException(`Count is ${c.status.toLowerCase()}`);
      const lines = await tx.stockCountLine.findMany({
        where: { stockCountId: id, countedQty: { not: null } },
        orderBy: { rawMaterialId: "asc" },
      });
      if (!lines.length) throw new BadRequestException("Nothing has been counted");

      let total = 0;
      let adjusted = 0;
      for (const line of lines) {
        const variance = round3(D(line.countedQty) - D(line.expectedQty));
        if (variance === 0) {
          await tx.stockCountLine.update({ where: { id: line.id }, data: { varianceQty: 0, varianceValue: 0 } });
          continue;
        }
        const rows = await tx.$queryRaw<{ costPerUnit: Prisma.Decimal }[]>`
          SELECT "costPerUnit" FROM raw_materials WHERE id = ${line.rawMaterialId}
          AND "tenantId" = ${user.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
        if (!rows.length) continue;
        const cost = D(rows[0].costPerUnit);
        const value = round2(variance * cost);
        await tx.rawMaterial.update({
          where: { id: line.rawMaterialId },
          data: { stockQty: { increment: variance } },
        });
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            outletId,
            rawMaterialId: line.rawMaterialId,
            type: "ADJUSTMENT",
            quantity: variance,
            unitCost: cost,
            reason: `Stocktake ${c.countNumber}${line.note ? `: ${line.note}` : ""}`,
            refType: "stocktake",
            refId: id,
            createdById: user.id,
          },
        });
        await tx.stockCountLine.update({
          where: { id: line.id },
          data: { varianceQty: variance, varianceValue: value },
        });
        total += value;
        adjusted += 1;
      }
      await tx.stockCount.update({
        where: { id },
        data: { status: "POSTED", postedAt: new Date(), postedById: user.id, varianceValue: round2(total) },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: "STOCKTAKE_POSTED",
          entity: "StockCount",
          entityId: id,
          data: { countNumber: c.countNumber, adjusted, varianceValue: round2(total) },
        },
      });
      return { id, status: "POSTED", adjusted, varianceValue: round2(total) };
    });
    this.realtime.notifyOutlet(outletId);
    return result;
  }

  private async lockCount(tx: Prisma.TransactionClient, user: AuthUser, outletId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string; status: string; countNumber: string }[]>`
      SELECT id, status, "countNumber" FROM stock_counts WHERE id = ${id} AND "tenantId" = ${user.tenantId}
      AND "outletId" = ${outletId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException("Stock count not found");
    return rows[0];
  }

  private toSummary(c: {
    id: string;
    countNumber: string;
    scope: string;
    category: string | null;
    status: string;
    startedAt: Date;
    postedAt: Date | null;
    varianceValue: Prisma.Decimal;
    lines: { countedQty: Prisma.Decimal | null }[];
  }): StockCountSummaryDto {
    return {
      id: c.id,
      countNumber: c.countNumber,
      scope: c.scope as StockCountSummaryDto["scope"],
      category: c.category,
      status: c.status as StockCountSummaryDto["status"],
      startedAt: c.startedAt.toISOString(),
      postedAt: c.postedAt?.toISOString() ?? null,
      lineCount: c.lines.length,
      countedCount: c.lines.filter((l) => l.countedQty !== null).length,
      varianceValue: D(c.varianceValue),
    };
  }
}
