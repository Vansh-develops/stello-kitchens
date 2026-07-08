import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  ConsumptionRowDto,
  CreateMaterialInput,
  ItemCostDto,
  ItemRecipeDto,
  MaterialUnit,
  PrepRecipeDto,
  ProduceBatchInput,
  RawMaterialDto,
  ReceiveStockInput,
  SetPrepRecipeInput,
  SetRecipeInput,
  StockMovementDto,
  UpdateMaterialInput,
  VendorDto,
  VendorInput,
  WastageInput,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

const D = (n: Prisma.Decimal | number) => (typeof n === "number" ? n : Number(n));

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  // ---------- Materials ----------

  async listMaterials(user: AuthUser, outletId: string): Promise<RawMaterialDto[]> {
    this.assertOutlet(user, outletId);
    const materials = await this.prisma.rawMaterial.findMany({
      where: { tenantId: user.tenantId, outletId, deletedAt: null },
      orderBy: { name: "asc" },
    });
    return materials.map((m) => this.toMaterialDto(m));
  }

  async createMaterial(user: AuthUser, outletId: string, input: CreateMaterialInput) {
    this.assertOutlet(user, outletId);
    const material = await this.prisma.rawMaterial.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        name: input.name,
        unit: input.unit,
        stockQty: input.stockQty ?? 0,
        reorderLevel: input.reorderLevel ?? 0,
        costPerUnit: input.costPerUnit ?? 0,
      },
    });
    // Seed an opening-balance movement if an initial stock was provided.
    if ((input.stockQty ?? 0) > 0) {
      await this.prisma.stockMovement.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          rawMaterialId: material.id,
          type: "ADJUSTMENT",
          quantity: input.stockQty ?? 0,
          unitCost: input.costPerUnit ?? 0,
          reason: "Opening balance",
          createdById: user.id,
        },
      });
    }
    return { id: material.id };
  }

  async updateMaterial(user: AuthUser, outletId: string, id: string, input: UpdateMaterialInput) {
    await this.requireMaterial(user, outletId, id);
    await this.prisma.rawMaterial.update({
      where: { id },
      data: { name: input.name, unit: input.unit, reorderLevel: input.reorderLevel },
    });
    return { id };
  }

  async deleteMaterial(user: AuthUser, outletId: string, id: string) {
    await this.requireMaterial(user, outletId, id);
    const usedBy = await this.prisma.recipeIngredient.count({ where: { rawMaterialId: id } });
    if (usedBy > 0) {
      throw new BadRequestException(`Material is used in ${usedBy} recipe(s); remove it there first`);
    }
    await this.prisma.rawMaterial.update({ where: { id }, data: { deletedAt: new Date() } });
    return { id };
  }

  /** Inward stock with a weighted-average cost update. */
  async receiveStock(user: AuthUser, outletId: string, id: string, input: ReceiveStockInput) {
    const material = await this.requireMaterial(user, outletId, id);
    const oldQty = D(material.stockQty);
    const oldCost = D(material.costPerUnit);
    const newQty = oldQty + input.quantity;
    // Weighted average of existing stock value + received value.
    const blendedCost =
      newQty > 0 ? (oldQty * oldCost + input.quantity * input.unitCost) / newQty : input.unitCost;

    await this.prisma.$transaction([
      this.prisma.rawMaterial.update({
        where: { id },
        data: { stockQty: newQty, costPerUnit: blendedCost },
      }),
      this.prisma.stockMovement.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          rawMaterialId: id,
          type: "RECEIPT",
          quantity: input.quantity,
          unitCost: input.unitCost,
          vendorId: input.vendorId ?? null,
          createdById: user.id,
        },
      }),
    ]);
    this.realtime.notifyOutlet(outletId);
    return { id, stockQty: newQty, costPerUnit: Math.round(blendedCost * 10000) / 10000 };
  }

  async recordWastage(user: AuthUser, outletId: string, id: string, input: WastageInput) {
    const material = await this.requireMaterial(user, outletId, id);
    const newQty = D(material.stockQty) - input.quantity;
    await this.prisma.$transaction([
      this.prisma.rawMaterial.update({ where: { id }, data: { stockQty: newQty } }),
      this.prisma.stockMovement.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          rawMaterialId: id,
          type: "WASTAGE",
          quantity: -input.quantity,
          unitCost: material.costPerUnit,
          reason: input.reason ?? null,
          createdById: user.id,
        },
      }),
    ]);
    this.realtime.notifyOutlet(outletId);
    return { id, stockQty: newQty };
  }

  // ---------- Vendors ----------

  async listVendors(user: AuthUser, outletId: string): Promise<VendorDto[]> {
    this.assertOutlet(user, outletId);
    const vendors = await this.prisma.vendor.findMany({
      where: { tenantId: user.tenantId, outletId, deletedAt: null },
      orderBy: { name: "asc" },
    });
    return vendors.map((v) => ({ id: v.id, name: v.name, phone: v.phone }));
  }

  async createVendor(user: AuthUser, outletId: string, input: VendorInput) {
    this.assertOutlet(user, outletId);
    const vendor = await this.prisma.vendor.create({
      data: { tenantId: user.tenantId, outletId, name: input.name, phone: input.phone ?? null },
    });
    return { id: vendor.id };
  }

  async deleteVendor(user: AuthUser, outletId: string, id: string) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id, outletId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!vendor) throw new NotFoundException("Vendor not found");
    await this.prisma.vendor.update({ where: { id }, data: { deletedAt: new Date() } });
    return { id };
  }

  // ---------- Recipes & costing ----------

  async getRecipe(user: AuthUser, outletId: string, itemId: string): Promise<ItemRecipeDto> {
    this.assertOutlet(user, outletId);
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, outletId, tenantId: user.tenantId, deletedAt: null },
      include: { recipe: { include: { material: true } } },
    });
    if (!item) throw new NotFoundException("Item not found");

    const ingredients = item.recipe.map((r) => {
      const lineCost = D(r.quantity) * D(r.material.costPerUnit);
      return {
        rawMaterialId: r.rawMaterialId,
        materialName: r.material.name,
        unit: r.material.unit as MaterialUnit,
        quantity: D(r.quantity),
        costPerUnit: D(r.material.costPerUnit),
        lineCost: Math.round(lineCost * 100) / 100,
      };
    });
    const foodCost = Math.round(ingredients.reduce((s, i) => s + i.lineCost, 0) * 100) / 100;
    const price = D(item.price);
    return {
      itemId: item.id,
      itemName: item.name,
      price,
      ingredients,
      foodCost,
      marginPct: price > 0 ? Math.round(((price - foodCost) / price) * 1000) / 10 : null,
    };
  }

  async setRecipe(user: AuthUser, outletId: string, itemId: string, input: SetRecipeInput) {
    this.assertOutlet(user, outletId);
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, outletId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!item) throw new NotFoundException("Item not found");

    // Validate materials belong to this outlet.
    const ids = input.ingredients.map((i) => i.rawMaterialId);
    if (ids.length) {
      const count = await this.prisma.rawMaterial.count({
        where: { id: { in: ids }, outletId, deletedAt: null },
      });
      if (count !== new Set(ids).size) throw new BadRequestException("Unknown raw material in recipe");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.recipeIngredient.deleteMany({ where: { itemId } });
      if (input.ingredients.length) {
        await tx.recipeIngredient.createMany({
          data: input.ingredients.map((i) => ({
            itemId,
            rawMaterialId: i.rawMaterialId,
            quantity: i.quantity,
          })),
        });
      }
    });
    return { itemId };
  }

  // ---------- Multi-stage recipes (semi-finished goods) ----------

  async getPrepRecipe(user: AuthUser, outletId: string, materialId: string): Promise<PrepRecipeDto> {
    const material = await this.requireMaterialWithPrep(user, outletId, materialId);
    const ingredients = material.prepRecipe.map((r) => {
      const lineCost = D(r.quantity) * D(r.input.costPerUnit);
      return {
        inputMaterialId: r.inputMaterialId,
        materialName: r.input.name,
        unit: r.input.unit as MaterialUnit,
        quantity: D(r.quantity),
        costPerUnit: D(r.input.costPerUnit),
        lineCost: Math.round(lineCost * 100) / 100,
        stockQty: D(r.input.stockQty),
      };
    });
    return {
      materialId: material.id,
      materialName: material.name,
      unit: material.unit as MaterialUnit,
      stockQty: D(material.stockQty),
      isSemiFinished: material.isSemiFinished,
      ingredients,
      unitCost: Math.round(ingredients.reduce((s, i) => s + i.lineCost, 0) * 100) / 100,
    };
  }

  async setPrepRecipe(user: AuthUser, outletId: string, materialId: string, input: SetPrepRecipeInput) {
    const material = await this.requireMaterial(user, outletId, materialId);

    const ids = input.ingredients.map((i) => i.inputMaterialId);
    if (ids.includes(materialId)) throw new BadRequestException("A material can't be its own ingredient");
    if (new Set(ids).size !== ids.length) throw new BadRequestException("Duplicate ingredient");
    if (ids.length) {
      const count = await this.prisma.rawMaterial.count({
        where: { id: { in: ids }, outletId, deletedAt: null },
      });
      if (count !== ids.length) throw new BadRequestException("Unknown input material in prep recipe");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.prepRecipeIngredient.deleteMany({ where: { outputMaterialId: materialId } });
      if (input.ingredients.length) {
        await tx.prepRecipeIngredient.createMany({
          data: input.ingredients.map((i) => ({
            outputMaterialId: materialId,
            inputMaterialId: i.inputMaterialId,
            quantity: i.quantity,
          })),
        });
      }
      // Having a prep recipe is what makes a material semi-finished.
      await tx.rawMaterial.update({
        where: { id: materialId },
        data: { isSemiFinished: input.ingredients.length > 0 },
      });
    });
    this.realtime.notifyOutlet(outletId);
    return { materialId, isSemiFinished: input.ingredients.length > 0 };
  }

  /**
   * Produce a batch: consume each input (scaled by batch size) and yield the output.
   * Output cost is a weighted average of existing stock value and this batch's cost.
   */
  async produceBatch(user: AuthUser, outletId: string, materialId: string, input: ProduceBatchInput) {
    const material = await this.requireMaterialWithPrep(user, outletId, materialId);
    if (!material.isSemiFinished || material.prepRecipe.length === 0) {
      throw new BadRequestException("This material has no prep recipe");
    }

    // Feasibility: every input must have enough stock for the whole batch.
    const needs = material.prepRecipe.map((r) => ({
      input: r.input,
      need: D(r.quantity) * input.quantity,
    }));
    for (const n of needs) {
      if (D(n.input.stockQty) < n.need) {
        throw new BadRequestException(
          `Not enough ${n.input.name}: need ${n.need} ${n.input.unit}, have ${D(n.input.stockQty)}`,
        );
      }
    }
    const batchCost = needs.reduce((s, n) => s + n.need * D(n.input.costPerUnit), 0);
    const oldQty = D(material.stockQty);
    const newQty = oldQty + input.quantity;
    const blendedCost =
      newQty > 0 ? (oldQty * D(material.costPerUnit) + batchCost) / newQty : D(material.costPerUnit);

    await this.prisma.$transaction(async (tx) => {
      for (const n of needs) {
        await tx.rawMaterial.update({
          where: { id: n.input.id },
          data: { stockQty: { decrement: n.need } },
        });
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            outletId,
            rawMaterialId: n.input.id,
            type: "PRODUCTION_OUT",
            quantity: -n.need,
            unitCost: n.input.costPerUnit,
            refType: "production",
            refId: materialId,
            createdById: user.id,
          },
        });
      }
      await tx.rawMaterial.update({
        where: { id: materialId },
        data: { stockQty: newQty, costPerUnit: blendedCost },
      });
      await tx.stockMovement.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          rawMaterialId: materialId,
          type: "PRODUCTION_IN",
          quantity: input.quantity,
          unitCost: batchCost / input.quantity,
          reason: `Produced ${input.quantity} ${material.unit}`,
          createdById: user.id,
        },
      });
    });
    this.realtime.notifyOutlet(outletId);
    return {
      id: materialId,
      stockQty: newQty,
      costPerUnit: Math.round(blendedCost * 10000) / 10000,
      batchCost: Math.round(batchCost * 100) / 100,
    };
  }

  private async requireMaterialWithPrep(user: AuthUser, outletId: string, materialId: string) {
    const material = await this.prisma.rawMaterial.findFirst({
      where: { id: materialId, outletId, tenantId: user.tenantId, deletedAt: null },
      include: { prepRecipe: { include: { input: true } } },
    });
    if (!material) throw new NotFoundException("Material not found");
    this.assertOutlet(user, outletId);
    return material;
  }

  async itemsCosting(user: AuthUser, outletId: string): Promise<ItemCostDto[]> {
    this.assertOutlet(user, outletId);
    const categories = await this.prisma.menuCategory.findMany({
      where: { tenantId: user.tenantId, outletId, deletedAt: null },
      orderBy: { sortOrder: "asc" },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: { name: "asc" },
          include: { recipe: { include: { material: true } } },
        },
      },
    });
    const rows: ItemCostDto[] = [];
    for (const c of categories) {
      for (const item of c.items) {
        const foodCost =
          Math.round(item.recipe.reduce((s, r) => s + D(r.quantity) * D(r.material.costPerUnit), 0) * 100) /
          100;
        const price = D(item.price);
        rows.push({
          itemId: item.id,
          categoryName: c.name,
          name: item.name,
          price,
          foodCost,
          marginPct: price > 0 ? Math.round(((price - foodCost) / price) * 1000) / 10 : null,
          ingredientCount: item.recipe.length,
        });
      }
    }
    return rows;
  }

  // ---------- Reports ----------

  async consumption(user: AuthUser, outletId: string, days: number): Promise<ConsumptionRowDto[]> {
    this.assertOutlet(user, outletId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        tenantId: user.tenantId,
        outletId,
        type: "CONSUMPTION",
        createdAt: { gte: since },
      },
      include: { material: true },
    });
    const agg = new Map<string, ConsumptionRowDto>();
    for (const m of movements) {
      const row = agg.get(m.rawMaterialId) ?? {
        rawMaterialId: m.rawMaterialId,
        name: m.material.name,
        unit: m.material.unit as MaterialUnit,
        consumedQty: 0,
        consumedCost: 0,
      };
      const qty = Math.abs(D(m.quantity));
      row.consumedQty += qty;
      row.consumedCost += qty * (m.unitCost ? D(m.unitCost) : D(m.material.costPerUnit));
      agg.set(m.rawMaterialId, row);
    }
    return [...agg.values()]
      .map((r) => ({
        ...r,
        consumedQty: Math.round(r.consumedQty * 1000) / 1000,
        consumedCost: Math.round(r.consumedCost * 100) / 100,
      }))
      .sort((a, b) => b.consumedCost - a.consumedCost);
  }

  async recentMovements(user: AuthUser, outletId: string): Promise<StockMovementDto[]> {
    this.assertOutlet(user, outletId);
    const movements = await this.prisma.stockMovement.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { material: true },
    });
    return movements.map((m) => ({
      id: m.id,
      type: m.type as StockMovementDto["type"],
      materialName: m.material.name,
      unit: m.material.unit as MaterialUnit,
      quantity: D(m.quantity),
      unitCost: m.unitCost ? D(m.unitCost) : null,
      reason: m.reason,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  private toMaterialDto(m: {
    id: string;
    name: string;
    unit: string;
    stockQty: Prisma.Decimal;
    reorderLevel: Prisma.Decimal;
    costPerUnit: Prisma.Decimal;
    isSemiFinished: boolean;
  }): RawMaterialDto {
    return {
      id: m.id,
      name: m.name,
      unit: m.unit as MaterialUnit,
      stockQty: D(m.stockQty),
      reorderLevel: D(m.reorderLevel),
      costPerUnit: D(m.costPerUnit),
      lowStock: D(m.stockQty) <= D(m.reorderLevel),
      isSemiFinished: m.isSemiFinished,
    };
  }

  private async requireMaterial(user: AuthUser, outletId: string, id: string) {
    const material = await this.prisma.rawMaterial.findFirst({
      where: { id, outletId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!material) throw new NotFoundException("Material not found");
    this.assertOutlet(user, outletId);
    return material;
  }
}
