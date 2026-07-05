import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  ComboDto,
  CreateComboInput,
  UpdateComboInput,
} from "@petpooja/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

type ComboWithSlots = Prisma.ComboGetPayload<{
  include: { slots: { include: { options: { include: { item: true } } } } };
}>;

const comboInclude = {
  slots: { orderBy: { sortOrder: "asc" as const }, include: { options: { include: { item: true } } } },
};

export function toComboDto(c: ComboWithSlots): ComboDto {
  return {
    id: c.id,
    categoryId: c.categoryId,
    name: c.name,
    price: Number(c.price),
    isVeg: c.isVeg,
    inStock: c.inStock,
    taxRate: Number(c.taxRate),
    slots: c.slots.map((s) => ({
      id: s.id,
      name: s.name,
      options: s.options.map((o) => ({
        id: o.id,
        itemId: o.itemId,
        name: o.item.name,
        priceDelta: Number(o.priceDelta),
        isDefault: o.isDefault,
        isVeg: o.item.isVeg,
        inStock: o.item.inStock,
      })),
    })),
  };
}

@Injectable()
export class CombosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  /** Flat combo list for menu surfacing (POS, dashboard, diner). */
  async listDtos(tenantId: string, outletId: string): Promise<ComboDto[]> {
    const combos = await this.prisma.combo.findMany({
      where: { tenantId, outletId, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: comboInclude,
    });
    return combos.map(toComboDto);
  }

  async list(user: AuthUser, outletId: string): Promise<ComboDto[]> {
    this.assertOutlet(user, outletId);
    return this.listDtos(user.tenantId, outletId);
  }

  async create(user: AuthUser, outletId: string, input: CreateComboInput): Promise<ComboDto> {
    this.assertOutlet(user, outletId);
    await this.assertCategory(user, outletId, input.categoryId);
    await this.assertOptionItems(outletId, input.slots);
    const combo = await this.prisma.combo.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        categoryId: input.categoryId,
        name: input.name,
        price: input.price,
        isVeg: input.isVeg,
        taxRate: input.taxRate,
        slots: {
          create: input.slots.map((s, si) => ({
            name: s.name,
            sortOrder: si,
            options: {
              create: s.options.map((o) => ({
                itemId: o.itemId,
                priceDelta: o.priceDelta,
                isDefault: o.isDefault,
              })),
            },
          })),
        },
      },
      include: comboInclude,
    });
    this.realtime.notifyOutlet(outletId);
    return toComboDto(combo);
  }

  async update(user: AuthUser, id: string, input: UpdateComboInput): Promise<ComboDto> {
    const combo = await this.requireCombo(user, id);
    if (input.categoryId) await this.assertCategory(user, combo.outletId, input.categoryId);
    if (input.slots) await this.assertOptionItems(combo.outletId, input.slots);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.combo.update({
        where: { id: combo.id },
        data: {
          categoryId: input.categoryId ?? undefined,
          name: input.name ?? undefined,
          price: input.price ?? undefined,
          isVeg: input.isVeg ?? undefined,
          taxRate: input.taxRate ?? undefined,
        },
      });
      // Rebuild slots/options wholesale when provided (cascade drops old options).
      if (input.slots) {
        await tx.comboSlot.deleteMany({ where: { comboId: combo.id } });
        for (const [si, s] of input.slots.entries()) {
          await tx.comboSlot.create({
            data: {
              comboId: combo.id,
              name: s.name,
              sortOrder: si,
              options: {
                create: s.options.map((o) => ({
                  itemId: o.itemId,
                  priceDelta: o.priceDelta,
                  isDefault: o.isDefault,
                })),
              },
            },
          });
        }
      }
      return tx.combo.findUniqueOrThrow({ where: { id: combo.id }, include: comboInclude });
    });
    this.realtime.notifyOutlet(combo.outletId);
    return toComboDto(updated);
  }

  async remove(user: AuthUser, id: string) {
    const combo = await this.requireCombo(user, id);
    await this.prisma.combo.update({ where: { id: combo.id }, data: { deletedAt: new Date() } });
    this.realtime.notifyOutlet(combo.outletId);
    return { id: combo.id };
  }

  async toggleStock(user: AuthUser, id: string, inStock: boolean) {
    const combo = await this.requireCombo(user, id);
    await this.prisma.combo.update({ where: { id: combo.id }, data: { inStock } });
    this.realtime.notifyOutlet(combo.outletId);
    return { id: combo.id, inStock };
  }

  // ---------- helpers ----------

  private async requireCombo(user: AuthUser, id: string) {
    const combo = await this.prisma.combo.findUnique({ where: { id } });
    if (!combo || combo.tenantId !== user.tenantId || combo.deletedAt) {
      throw new NotFoundException("Combo not found");
    }
    this.assertOutlet(user, combo.outletId);
    return combo;
  }

  private async assertCategory(user: AuthUser, outletId: string, categoryId: string) {
    const cat = await this.prisma.menuCategory.findFirst({
      where: { id: categoryId, outletId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!cat) throw new BadRequestException("Category not found for this outlet");
  }

  private async assertOptionItems(
    outletId: string,
    slots: { options: { itemId: string }[] }[],
  ) {
    const itemIds = [...new Set(slots.flatMap((s) => s.options.map((o) => o.itemId)))];
    const found = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, outletId, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== itemIds.length) {
      throw new BadRequestException("A combo option refers to an item not in this outlet");
    }
  }
}
