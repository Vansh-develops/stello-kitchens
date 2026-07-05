import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type {
  AuthUser,
  CentralKitchenContextDto,
  CreateIndentInput,
  EwayBillDto,
  IndentDto,
  MaterialUnit,
} from "@petpooja/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const r2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class CentralKitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async context(user: AuthUser, outletId: string): Promise<CentralKitchenContextDto> {
    this.assertOutlet(user, outletId);
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    const central = await this.prisma.outlet.findFirst({
      where: { tenantId: user.tenantId, isCentralKitchen: true },
    });
    const outlets = await this.prisma.outlet.findMany({
      where: { tenantId: user.tenantId, id: { in: user.outletIds } },
      orderBy: { name: "asc" },
    });
    const centralMaterials = central
      ? await this.prisma.rawMaterial.findMany({
          where: { outletId: central.id, deletedAt: null },
          orderBy: { name: "asc" },
        })
      : [];
    return {
      role: outlet.isCentralKitchen ? "central" : central ? "satellite" : "none",
      centralKitchen: central ? { id: central.id, name: central.name } : null,
      satellites: outlets.filter((o) => !o.isCentralKitchen).map((o) => ({ id: o.id, name: o.name })),
      centralMaterials: centralMaterials.map((m) => ({
        id: m.id,
        name: m.name,
        unit: m.unit as MaterialUnit,
        stockQty: N(m.stockQty),
      })),
    };
  }

  async createIndent(user: AuthUser, fromOutletId: string, input: CreateIndentInput) {
    this.assertOutlet(user, fromOutletId);
    const central = await this.prisma.outlet.findFirst({
      where: { id: input.toOutletId, tenantId: user.tenantId, isCentralKitchen: true },
    });
    if (!central) throw new BadRequestException("Target is not a central kitchen");
    if (input.toOutletId === fromOutletId) throw new BadRequestException("Cannot indent from itself");

    const materials = await this.prisma.rawMaterial.findMany({
      where: { id: { in: input.items.map((i) => i.rawMaterialId) }, outletId: central.id, deletedAt: null },
    });
    const byId = new Map(materials.map((m) => [m.id, m]));

    const indent = await this.prisma.indent.create({
      data: {
        tenantId: user.tenantId,
        fromOutletId,
        toOutletId: input.toOutletId,
        note: input.note ?? null,
        items: {
          create: input.items.map((i) => {
            const m = byId.get(i.rawMaterialId);
            if (!m) throw new BadRequestException("Unknown central-kitchen material");
            return {
              rawMaterialId: m.id,
              materialName: m.name,
              unit: m.unit,
              requestedQty: i.requestedQty,
              unitCost: m.costPerUnit,
            };
          }),
        },
      },
    });
    return { id: indent.id };
  }

  async list(user: AuthUser, outletId: string): Promise<IndentDto[]> {
    this.assertOutlet(user, outletId);
    const indents = await this.prisma.indent.findMany({
      where: { tenantId: user.tenantId, OR: [{ fromOutletId: outletId }, { toOutletId: outletId }] },
      orderBy: { createdAt: "desc" },
      include: { items: true, ewayBill: true },
    });
    const outletIds = [...new Set(indents.flatMap((i) => [i.fromOutletId, i.toOutletId]))];
    const outlets = await this.prisma.outlet.findMany({ where: { id: { in: outletIds } } });
    const name = (id: string) => outlets.find((o) => o.id === id)?.name ?? "—";

    return indents.map((i) => {
      const value = i.items.reduce((s, it) => s + (N(it.dispatchedQty) || N(it.requestedQty)) * N(it.unitCost), 0);
      return {
        id: i.id,
        direction: i.fromOutletId === outletId ? "outgoing" : "incoming",
        fromOutletId: i.fromOutletId,
        fromOutletName: name(i.fromOutletId),
        toOutletId: i.toOutletId,
        toOutletName: name(i.toOutletId),
        status: i.status as IndentDto["status"],
        note: i.note,
        createdAt: i.createdAt.toISOString(),
        dispatchedAt: i.dispatchedAt?.toISOString() ?? null,
        receivedAt: i.receivedAt?.toISOString() ?? null,
        value: r2(value),
        items: i.items.map((it) => ({
          id: it.id,
          rawMaterialId: it.rawMaterialId,
          materialName: it.materialName,
          unit: it.unit as MaterialUnit,
          requestedQty: N(it.requestedQty),
          dispatchedQty: N(it.dispatchedQty),
        })),
        ewayBill: i.ewayBill ? this.toEwayDto(i.ewayBill) : null,
      };
    });
  }

  /** Central kitchen fulfils an indent: deplete its stock, mark dispatched. */
  async dispatch(user: AuthUser, indentId: string) {
    const indent = await this.require(user, indentId);
    if (indent.status !== "DRAFT") throw new BadRequestException("Indent is not open for dispatch");
    this.assertOutlet(user, indent.toOutletId); // must operate the central kitchen

    await this.prisma.$transaction(async (tx) => {
      for (const item of indent.items) {
        await tx.rawMaterial.update({
          where: { id: item.rawMaterialId },
          data: { stockQty: { decrement: N(item.requestedQty) } },
        });
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            outletId: indent.toOutletId,
            rawMaterialId: item.rawMaterialId,
            type: "TRANSFER_OUT",
            quantity: -N(item.requestedQty),
            unitCost: item.unitCost,
            reason: `Indent dispatch → ${indent.fromOutletId}`,
            refType: "indent",
            refId: indent.id,
            createdById: user.id,
          },
        });
        await tx.indentItem.update({ where: { id: item.id }, data: { dispatchedQty: item.requestedQty } });
      }
      await tx.indent.update({ where: { id: indent.id }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
    });
    this.realtime.notifyOutlet(indent.toOutletId);
    return { id: indent.id, status: "DISPATCHED" };
  }

  /** Satellite receives a dispatched indent: top up its stock (creating materials as needed). */
  async receive(user: AuthUser, indentId: string) {
    const indent = await this.require(user, indentId);
    if (indent.status !== "DISPATCHED") throw new BadRequestException("Indent has not been dispatched");
    this.assertOutlet(user, indent.fromOutletId); // must operate the receiving outlet

    await this.prisma.$transaction(async (tx) => {
      for (const item of indent.items) {
        // Match by name at the satellite; create the material if it doesn't exist yet.
        let material = await tx.rawMaterial.findFirst({
          where: { outletId: indent.fromOutletId, name: item.materialName, deletedAt: null },
        });
        if (!material) {
          material = await tx.rawMaterial.create({
            data: {
              tenantId: user.tenantId,
              outletId: indent.fromOutletId,
              name: item.materialName,
              unit: item.unit,
              costPerUnit: item.unitCost,
              stockQty: 0,
            },
          });
        }
        await tx.rawMaterial.update({
          where: { id: material.id },
          data: { stockQty: { increment: N(item.dispatchedQty) } },
        });
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            outletId: indent.fromOutletId,
            rawMaterialId: material.id,
            type: "TRANSFER_IN",
            quantity: N(item.dispatchedQty),
            unitCost: item.unitCost,
            reason: `Indent receipt ← ${indent.toOutletId}`,
            refType: "indent",
            refId: indent.id,
            createdById: user.id,
          },
        });
      }
      await tx.indent.update({ where: { id: indent.id }, data: { status: "RECEIVED", receivedAt: new Date() } });
    });
    this.realtime.notifyOutlet(indent.fromOutletId);
    return { id: indent.id, status: "RECEIVED" };
  }

  /** Generate an e-way bill for a dispatched indent (mock GSP, like the IRN flow). */
  async generateEwayBill(user: AuthUser, indentId: string, distanceKm?: number): Promise<EwayBillDto> {
    const indent = await this.require(user, indentId);
    if (indent.status !== "DISPATCHED" && indent.status !== "RECEIVED") {
      throw new BadRequestException("Dispatch the indent before generating an e-way bill");
    }
    const existing = await this.prisma.ewayBill.findUnique({ where: { indentId } });
    if (existing) throw new BadRequestException("An e-way bill already exists for this indent");

    const [from, to] = await Promise.all([
      this.prisma.outlet.findUniqueOrThrow({ where: { id: indent.toOutletId } }), // consignor = central
      this.prisma.outlet.findUniqueOrThrow({ where: { id: indent.fromOutletId } }), // consignee = satellite
    ]);
    const value = r2(indent.items.reduce((s, it) => s + N(it.dispatchedQty) * N(it.unitCost), 0));
    // 12-digit EWB number (mock). Real: POST to the EWB API via the GSP.
    const ewbNo = (
      100000000000n + BigInt(parseInt(createHash("sha256").update(indentId).digest("hex").slice(0, 11), 16) % 900000000000)
    ).toString();
    const dist = distanceKm ?? 12;
    const validDays = Math.max(1, Math.ceil(dist / 200));
    const ewb = await this.prisma.ewayBill.create({
      data: {
        tenantId: user.tenantId,
        indentId,
        ewbNo,
        value,
        fromGstin: from.gstin,
        toGstin: to.gstin,
        distanceKm: dist,
        validUntil: new Date(Date.now() + validDays * 86400_000),
      },
    });
    return this.toEwayDto(ewb);
  }

  private async require(user: AuthUser, indentId: string) {
    const indent = await this.prisma.indent.findFirst({
      where: { id: indentId, tenantId: user.tenantId },
      include: { items: true },
    });
    if (!indent) throw new NotFoundException("Indent not found");
    return indent;
  }

  private toEwayDto(e: {
    id: string;
    ewbNo: string;
    value: Prisma.Decimal;
    fromGstin: string | null;
    toGstin: string | null;
    distanceKm: number | null;
    validUntil: Date | null;
    status: string;
    generatedAt: Date;
  }): EwayBillDto {
    return {
      id: e.id,
      ewbNo: e.ewbNo,
      value: N(e.value),
      fromGstin: e.fromGstin,
      toGstin: e.toGstin,
      distanceKm: e.distanceKm,
      validUntil: e.validUntil?.toISOString() ?? null,
      status: e.status,
      generatedAt: e.generatedAt.toISOString(),
    };
  }
}
