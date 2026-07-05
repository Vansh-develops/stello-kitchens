import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AddonGroupInput,
  AdminMenuDto,
  AuthUser,
  ChannelInput,
  CreateCategoryInput,
  CreateItemInput,
  UpdateCategoryInput,
  UpdateItemInput,
} from "@petpooja/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { CombosService } from "../combos/combos.service";

@Injectable()
export class MenuAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly combos: CombosService,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  /** Full editable menu: categories→items (with channel config), addon groups, channels, stations. */
  async adminMenu(user: AuthUser, outletId: string): Promise<AdminMenuDto> {
    this.assertOutlet(user, outletId);
    const [categories, addonGroups, channels, stations, combos] = await Promise.all([
      this.prisma.menuCategory.findMany({
        where: { tenantId: user.tenantId, outletId, deletedAt: null },
        orderBy: { sortOrder: "asc" },
        include: {
          items: {
            where: { deletedAt: null },
            orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
            include: {
              variations: true,
              addonGroups: true,
              channelPrices: true,
              menuMaps: true,
            },
          },
        },
      }),
      this.prisma.addonGroup.findMany({
        where: { tenantId: user.tenantId, outletId },
        orderBy: { name: "asc" },
        include: { addons: true },
      }),
      this.prisma.channel.findMany({
        where: { tenantId: user.tenantId, outletId },
        orderBy: { sortOrder: "asc" },
      }),
      this.prisma.station.findMany({
        where: { tenantId: user.tenantId, outletId },
        orderBy: { sortOrder: "asc" },
      }),
      this.combos.listDtos(user.tenantId, outletId),
    ]);

    return {
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sortOrder,
        stationId: c.stationId,
        items: c.items.map((i) => {
          const priceByChannel = new Map(i.channelPrices.map((p) => [p.channelId, p]));
          const mapByChannel = new Map(i.menuMaps.map((m) => [m.channelId, m.externalId]));
          return {
            id: i.id,
            categoryId: i.categoryId,
            name: i.name,
            shortCode: i.shortCode,
            price: Number(i.price),
            isVeg: i.isVeg,
            inStock: i.inStock,
            taxRate: Number(i.taxRate),
            sortOrder: i.sortOrder,
            availableStart: i.availableStart,
            availableEnd: i.availableEnd,
            variations: i.variations.map((v) => ({ id: v.id, name: v.name, price: Number(v.price) })),
            addonGroupIds: i.addonGroups.map((ag) => ag.addonGroupId),
            channels: channels.map((ch) => ({
              channelId: ch.id,
              price: priceByChannel.has(ch.id) ? Number(priceByChannel.get(ch.id)!.price) : null,
              isListed: priceByChannel.get(ch.id)?.isListed ?? true,
              externalId: mapByChannel.get(ch.id) ?? null,
            })),
          };
        }),
      })),
      addonGroups: addonGroups.map((g) => ({
        id: g.id,
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        addons: g.addons.map((a) => ({ id: a.id, name: a.name, price: Number(a.price) })),
      })),
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind as "DIRECT" | "AGGREGATOR",
        isActive: c.isActive,
        sortOrder: c.sortOrder,
      })),
      stations: stations.map((s) => ({
        id: s.id,
        name: s.name,
        prepMinutes: s.prepMinutes,
        sortOrder: s.sortOrder,
      })),
      combos,
    };
  }

  // ---------- Categories ----------

  async createCategory(user: AuthUser, outletId: string, input: CreateCategoryInput) {
    this.assertOutlet(user, outletId);
    const cat = await this.prisma.menuCategory.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        name: input.name,
        stationId: input.stationId ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    this.realtime.notifyOutlet(outletId);
    return { id: cat.id };
  }

  async updateCategory(user: AuthUser, outletId: string, id: string, input: UpdateCategoryInput) {
    await this.requireCategory(user, outletId, id);
    await this.prisma.menuCategory.update({
      where: { id },
      data: {
        name: input.name,
        stationId: input.stationId === undefined ? undefined : input.stationId,
        sortOrder: input.sortOrder,
      },
    });
    this.realtime.notifyOutlet(outletId);
    return { id };
  }

  async deleteCategory(user: AuthUser, outletId: string, id: string) {
    await this.requireCategory(user, outletId, id);
    const itemCount = await this.prisma.item.count({ where: { categoryId: id, deletedAt: null } });
    if (itemCount > 0) {
      // Soft-delete the category and its items together.
      await this.prisma.item.updateMany({
        where: { categoryId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }
    await this.prisma.menuCategory.update({ where: { id }, data: { deletedAt: new Date() } });
    this.realtime.notifyOutlet(outletId);
    return { id, removedItems: itemCount };
  }

  // ---------- Items ----------

  async createItem(user: AuthUser, outletId: string, input: CreateItemInput) {
    this.assertOutlet(user, outletId);
    await this.requireCategory(user, outletId, input.categoryId);
    const item = await this.prisma.item.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        categoryId: input.categoryId,
        name: input.name,
        shortCode: input.shortCode ?? null,
        price: input.price,
        isVeg: input.isVeg ?? true,
        taxRate: input.taxRate ?? 5,
        sortOrder: input.sortOrder ?? 0,
        availableStart: input.availableStart ?? null,
        availableEnd: input.availableEnd ?? null,
        variations: { create: (input.variations ?? []).map((v) => ({ name: v.name, price: v.price })) },
        addonGroups: {
          create: (input.addonGroupIds ?? []).map((agId) => ({ addonGroupId: agId })),
        },
      },
    });
    await this.applyChannels(outletId, item.id, input.channels ?? []);
    this.realtime.notifyOutlet(outletId);
    return { id: item.id };
  }

  async updateItem(user: AuthUser, outletId: string, id: string, input: UpdateItemInput) {
    const item = await this.prisma.item.findFirst({
      where: { id, outletId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!item) throw new NotFoundException("Item not found");
    this.assertOutlet(user, outletId);

    await this.prisma.$transaction(async (tx) => {
      await tx.item.update({
        where: { id },
        data: {
          categoryId: input.categoryId,
          name: input.name,
          shortCode: input.shortCode === undefined ? undefined : input.shortCode,
          price: input.price,
          isVeg: input.isVeg,
          taxRate: input.taxRate,
          sortOrder: input.sortOrder,
          availableStart: input.availableStart === undefined ? undefined : input.availableStart,
          availableEnd: input.availableEnd === undefined ? undefined : input.availableEnd,
        },
      });
      // Replace variations if provided (order history keeps snapshots).
      if (input.variations) {
        await tx.itemVariation.deleteMany({ where: { itemId: id } });
        if (input.variations.length) {
          await tx.itemVariation.createMany({
            data: input.variations.map((v) => ({ itemId: id, name: v.name, price: v.price })),
          });
        }
      }
      // Replace addon-group links if provided.
      if (input.addonGroupIds) {
        await tx.itemAddonGroup.deleteMany({ where: { itemId: id } });
        if (input.addonGroupIds.length) {
          await tx.itemAddonGroup.createMany({
            data: input.addonGroupIds.map((agId) => ({ itemId: id, addonGroupId: agId })),
          });
        }
      }
    });
    if (input.channels) await this.applyChannels(outletId, id, input.channels);
    this.realtime.notifyOutlet(outletId);
    return { id };
  }

  async deleteItem(user: AuthUser, outletId: string, id: string) {
    const item = await this.prisma.item.findFirst({
      where: { id, outletId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!item) throw new NotFoundException("Item not found");
    await this.prisma.item.update({ where: { id }, data: { deletedAt: new Date() } });
    this.realtime.notifyOutlet(outletId);
    return { id };
  }

  /** Upserts per-channel price overrides + aggregator external-id maps for one item. */
  private async applyChannels(
    outletId: string,
    itemId: string,
    channels: NonNullable<CreateItemInput["channels"]>,
  ) {
    const valid = await this.prisma.channel.findMany({
      where: { outletId },
      select: { id: true },
    });
    const validIds = new Set(valid.map((c) => c.id));

    for (const cfg of channels) {
      if (!validIds.has(cfg.channelId)) continue;

      // Price override: a value creates/updates a row; null clears it (base price).
      if (cfg.price === null || cfg.price === undefined) {
        await this.prisma.itemChannelPrice.deleteMany({
          where: { itemId, channelId: cfg.channelId },
        });
      } else {
        await this.prisma.itemChannelPrice.upsert({
          where: { itemId_channelId: { itemId, channelId: cfg.channelId } },
          create: {
            itemId,
            channelId: cfg.channelId,
            price: cfg.price,
            isListed: cfg.isListed ?? true,
          },
          update: { price: cfg.price, isListed: cfg.isListed ?? true },
        });
      }

      // Aggregator external id: value upserts, empty/null clears.
      const ext = cfg.externalId?.trim();
      if (ext) {
        await this.prisma.aggregatorMenuMap.upsert({
          where: { itemId_channelId: { itemId, channelId: cfg.channelId } },
          create: { itemId, channelId: cfg.channelId, externalId: ext },
          update: { externalId: ext },
        });
      } else {
        await this.prisma.aggregatorMenuMap.deleteMany({
          where: { itemId, channelId: cfg.channelId },
        });
      }
    }
  }

  // ---------- Addon groups ----------

  async createAddonGroup(user: AuthUser, outletId: string, input: AddonGroupInput) {
    this.assertOutlet(user, outletId);
    const group = await this.prisma.addonGroup.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        name: input.name,
        minSelect: input.minSelect ?? 0,
        maxSelect: input.maxSelect ?? 1,
        addons: { create: input.addons.map((a) => ({ name: a.name, price: a.price })) },
      },
    });
    this.realtime.notifyOutlet(outletId);
    return { id: group.id };
  }

  async updateAddonGroup(user: AuthUser, outletId: string, id: string, input: AddonGroupInput) {
    const group = await this.prisma.addonGroup.findFirst({ where: { id, outletId, tenantId: user.tenantId } });
    if (!group) throw new NotFoundException("Addon group not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.addonGroup.update({
        where: { id },
        data: { name: input.name, minSelect: input.minSelect, maxSelect: input.maxSelect },
      });
      await tx.addon.deleteMany({ where: { groupId: id } });
      await tx.addon.createMany({
        data: input.addons.map((a) => ({ groupId: id, name: a.name, price: a.price })),
      });
    });
    this.realtime.notifyOutlet(outletId);
    return { id };
  }

  async deleteAddonGroup(user: AuthUser, outletId: string, id: string) {
    const group = await this.prisma.addonGroup.findFirst({ where: { id, outletId, tenantId: user.tenantId } });
    if (!group) throw new NotFoundException("Addon group not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.itemAddonGroup.deleteMany({ where: { addonGroupId: id } });
      await tx.addon.deleteMany({ where: { groupId: id } });
      await tx.addonGroup.delete({ where: { id } });
    });
    this.realtime.notifyOutlet(outletId);
    return { id };
  }

  // ---------- Channels ----------

  async createChannel(user: AuthUser, outletId: string, input: ChannelInput) {
    this.assertOutlet(user, outletId);
    const channel = await this.prisma.channel.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        name: input.name,
        kind: input.kind ?? "DIRECT",
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    this.realtime.notifyOutlet(outletId);
    return { id: channel.id };
  }

  async updateChannel(user: AuthUser, outletId: string, id: string, input: Partial<ChannelInput>) {
    const channel = await this.prisma.channel.findFirst({ where: { id, outletId, tenantId: user.tenantId } });
    if (!channel) throw new NotFoundException("Channel not found");
    await this.prisma.channel.update({
      where: { id },
      data: {
        name: input.name,
        kind: input.kind,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      },
    });
    this.realtime.notifyOutlet(outletId);
    return { id };
  }

  async deleteChannel(user: AuthUser, outletId: string, id: string) {
    const channel = await this.prisma.channel.findFirst({ where: { id, outletId, tenantId: user.tenantId } });
    if (!channel) throw new NotFoundException("Channel not found");
    await this.prisma.channel.delete({ where: { id } });
    this.realtime.notifyOutlet(outletId);
    return { id };
  }

  private async requireCategory(user: AuthUser, outletId: string, id: string) {
    const cat = await this.prisma.menuCategory.findFirst({
      where: { id, outletId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!cat) throw new NotFoundException("Category not found");
    this.assertOutlet(user, outletId);
    return cat;
  }
}

// keep Prisma import referenced for typing consistency in transactions
void Prisma;
