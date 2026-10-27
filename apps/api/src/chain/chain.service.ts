import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  AuthUser,
  BrandSummaryDto,
  CreateChainOutletInput,
  MasterAddonGroupInput,
  MasterCategoryInput,
  MasterComboInput,
  MasterItemInput,
  MasterMenuDto,
  MasterOverrideDto,
  MasterOverrideInput,
  OutletSyncDto,
  PublishPlanDto,
  UpdateMasterItemInput,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { resolveMasterItem, syncOutlet } from "./menu-sync";

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => v as Prisma.InputJsonValue;
const translations = (v: Record<string, string> | null | undefined) => {
  if (v === undefined) return undefined;
  const clean = Object.fromEntries(Object.entries(v ?? {}).filter(([, s]) => s.trim()));
  return Object.keys(clean).length ? json(clean) : Prisma.DbNull;
};

/**
 * Brand-level master menu for chains / franchises. Brand admins (chain.manage)
 * edit the master and publish it to outlets; outlet managers (menu.manage) set
 * per-outlet overrides. Outlet menus remain ordinary rows — POS, KDS, Scan &
 * Order and aggregators keep reading them unchanged; a row is "master-managed"
 * only by virtue of its master*Id link.
 */
@Injectable()
export class ChainService {
  private readonly logger = new Logger("ChainMenu");

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ---------- brands & status ----------

  async brands(user: AuthUser): Promise<BrandSummaryDto[]> {
    const [brands, menus] = await Promise.all([
      this.prisma.brand.findMany({
        where: { tenantId: user.tenantId },
        include: { _count: { select: { outlets: true } } },
        orderBy: { name: "asc" },
      }),
      this.prisma.masterMenu.findMany({ where: { tenantId: user.tenantId } }),
    ]);
    const versionBy = new Map(menus.map((m) => [m.brandId, m.version]));
    return brands.map((b) => ({ id: b.id, name: b.name, outletCount: b._count.outlets, version: versionBy.get(b.id) ?? 0 }));
  }

  async masterMenu(user: AuthUser, brandId: string): Promise<MasterMenuDto> {
    const brand = await this.requireBrand(user, brandId);
    const tenantId = user.tenantId;
    const [menu, cats, items, groups, combos] = await Promise.all([
      this.prisma.masterMenu.findUnique({ where: { brandId } }),
      this.prisma.masterCategory.findMany({ where: { tenantId, brandId, deletedAt: null }, orderBy: { sortOrder: "asc" } }),
      this.prisma.masterItem.findMany({
        where: { tenantId, brandId, deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      this.prisma.masterAddonGroup.findMany({ where: { tenantId, brandId, deletedAt: null }, orderBy: { name: "asc" } }),
      this.prisma.masterCombo.findMany({ where: { tenantId, brandId, deletedAt: null }, orderBy: { sortOrder: "asc" } }),
    ]);
    return {
      brandId,
      brandName: brand.name,
      version: menu?.version ?? 0,
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sortOrder,
        stationName: c.stationName,
        items: items.filter((i) => i.categoryId === c.id).map((i) => this.itemDto(i)),
      })),
      addonGroups: groups.map((g) => ({
        id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect,
        addons: (g.addons as { name: string; price: number }[]) ?? [],
      })),
      combos: combos.map((c) => ({
        id: c.id, categoryId: c.categoryId, name: c.name, price: Number(c.price), isVeg: c.isVeg,
        taxRate: Number(c.taxRate), hsnCode: c.hsnCode, sortOrder: c.sortOrder,
        slots: (c.slots as MasterMenuDto["combos"][number]["slots"]) ?? [],
      })),
      outlets: await this.outletStatus(user, brandId, menu?.version ?? 0),
    };
  }

  private async outletStatus(user: AuthUser, brandId: string, version: number): Promise<OutletSyncDto[]> {
    const outlets = await this.prisma.outlet.findMany({
      where: { tenantId: user.tenantId, brandId, id: { in: user.outletIds } },
      orderBy: { name: "asc" },
    });
    const ids = outlets.map((o) => o.id);
    const [syncs, overrides, outletOnly] = await Promise.all([
      this.prisma.outletMenuSync.findMany({ where: { tenantId: user.tenantId, outletId: { in: ids } } }),
      this.prisma.masterItemOverride.groupBy({
        by: ["outletId"],
        where: { tenantId: user.tenantId, outletId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.item.groupBy({
        by: ["outletId"],
        where: { tenantId: user.tenantId, outletId: { in: ids }, masterItemId: null, deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const syncBy = new Map(syncs.map((s) => [s.outletId, s]));
    const ovBy = new Map(overrides.map((o) => [o.outletId, o._count._all]));
    const onlyBy = new Map(outletOnly.map((o) => [o.outletId, o._count._all]));
    return outlets.map((o) => {
      const s = syncBy.get(o.id);
      const status: OutletSyncDto["status"] = !s
        ? "NEVER"
        : s.status === "FAILED"
          ? "FAILED"
          : s.publishedVersion === version
            ? "IN_SYNC"
            : "PENDING";
      return {
        outletId: o.id,
        outletName: o.name,
        publishedVersion: s?.publishedVersion ?? 0,
        status,
        lastPublishedAt: s?.lastPublishedAt?.toISOString() ?? null,
        lastError: s?.lastError ?? null,
        overrideCount: ovBy.get(o.id) ?? 0,
        outletOnlyItems: onlyBy.get(o.id) ?? 0,
      };
    });
  }

  // ---------- master CRUD (each write bumps the brand's master version) ----------

  async createCategory(user: AuthUser, brandId: string, input: MasterCategoryInput) {
    await this.requireBrand(user, brandId);
    return this.edit(user.tenantId, brandId, async (tx) => {
      const c = await tx.masterCategory.create({
        data: {
          tenantId: user.tenantId, brandId, name: input.name, sortOrder: input.sortOrder ?? 0,
          stationName: input.stationName ?? null,
        },
      });
      return { id: c.id };
    });
  }

  async updateCategory(user: AuthUser, brandId: string, id: string, input: Partial<MasterCategoryInput>) {
    await this.requireMaster(user, brandId, "masterCategory", id);
    return this.edit(user.tenantId, brandId, async (tx) => {
      await tx.masterCategory.update({
        where: { id },
        data: { name: input.name, sortOrder: input.sortOrder, stationName: input.stationName },
      });
      return { id };
    });
  }

  async deleteCategory(user: AuthUser, brandId: string, id: string) {
    await this.requireMaster(user, brandId, "masterCategory", id);
    return this.edit(user.tenantId, brandId, async (tx) => {
      const now = new Date();
      await tx.masterItem.updateMany({ where: { categoryId: id, deletedAt: null }, data: { deletedAt: now, version: { increment: 1 } } });
      await tx.masterCombo.updateMany({ where: { categoryId: id, deletedAt: null }, data: { deletedAt: now } });
      await tx.masterCategory.update({ where: { id }, data: { deletedAt: now } });
      return { id };
    });
  }

  async createItem(user: AuthUser, brandId: string, input: MasterItemInput) {
    await this.requireBrand(user, brandId);
    await this.requireMaster(user, brandId, "masterCategory", input.categoryId);
    await this.checkAddonGroups(user, brandId, input.addonGroupIds);
    return this.edit(user.tenantId, brandId, async (tx) => {
      const i = await tx.masterItem.create({
        data: {
          tenantId: user.tenantId, brandId, categoryId: input.categoryId, name: input.name,
          shortCode: input.shortCode ?? null, price: input.price, isVeg: input.isVeg ?? true,
          taxRate: input.taxRate ?? 5, hsnCode: input.hsnCode ?? "996331", sortOrder: input.sortOrder ?? 0,
          availableStart: input.availableStart ?? null, availableEnd: input.availableEnd ?? null,
          variations: json(input.variations ?? []), addonGroupIds: json(input.addonGroupIds ?? []),
          nameTranslations: translations(input.nameTranslations ?? null),
        },
      });
      return { id: i.id };
    });
  }

  async updateItem(user: AuthUser, brandId: string, id: string, input: UpdateMasterItemInput) {
    await this.requireMaster(user, brandId, "masterItem", id);
    if (input.categoryId) await this.requireMaster(user, brandId, "masterCategory", input.categoryId);
    if (input.addonGroupIds) await this.checkAddonGroups(user, brandId, input.addonGroupIds);
    return this.edit(user.tenantId, brandId, async (tx) => {
      await tx.masterItem.update({
        where: { id },
        data: {
          categoryId: input.categoryId, name: input.name, shortCode: input.shortCode, price: input.price,
          isVeg: input.isVeg, taxRate: input.taxRate, hsnCode: input.hsnCode, sortOrder: input.sortOrder,
          availableStart: input.availableStart, availableEnd: input.availableEnd,
          variations: input.variations ? json(input.variations) : undefined,
          addonGroupIds: input.addonGroupIds ? json(input.addonGroupIds) : undefined,
          nameTranslations: translations(input.nameTranslations),
          version: { increment: 1 },
        },
      });
      return { id };
    });
  }

  async deleteItem(user: AuthUser, brandId: string, id: string) {
    await this.requireMaster(user, brandId, "masterItem", id);
    return this.edit(user.tenantId, brandId, async (tx) => {
      await tx.masterItem.update({ where: { id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
      return { id };
    });
  }

  async createAddonGroup(user: AuthUser, brandId: string, input: MasterAddonGroupInput) {
    await this.requireBrand(user, brandId);
    return this.edit(user.tenantId, brandId, async (tx) => {
      const g = await tx.masterAddonGroup.create({
        data: {
          tenantId: user.tenantId, brandId, name: input.name, minSelect: input.minSelect ?? 0,
          maxSelect: input.maxSelect ?? 1, addons: json(input.addons),
        },
      });
      return { id: g.id };
    });
  }

  async updateAddonGroup(user: AuthUser, brandId: string, id: string, input: MasterAddonGroupInput) {
    await this.requireMaster(user, brandId, "masterAddonGroup", id);
    return this.edit(user.tenantId, brandId, async (tx) => {
      await tx.masterAddonGroup.update({
        where: { id },
        data: { name: input.name, minSelect: input.minSelect, maxSelect: input.maxSelect, addons: json(input.addons) },
      });
      return { id };
    });
  }

  async deleteAddonGroup(user: AuthUser, brandId: string, id: string) {
    await this.requireMaster(user, brandId, "masterAddonGroup", id);
    return this.edit(user.tenantId, brandId, async (tx) => {
      await tx.masterAddonGroup.update({ where: { id }, data: { deletedAt: new Date() } });
      return { id };
    });
  }

  async createCombo(user: AuthUser, brandId: string, input: MasterComboInput) {
    await this.requireBrand(user, brandId);
    await this.requireMaster(user, brandId, "masterCategory", input.categoryId);
    await this.checkComboItems(user, brandId, input);
    return this.edit(user.tenantId, brandId, async (tx) => {
      const c = await tx.masterCombo.create({
        data: {
          tenantId: user.tenantId, brandId, categoryId: input.categoryId, name: input.name, price: input.price,
          isVeg: input.isVeg ?? true, taxRate: input.taxRate ?? 5, hsnCode: input.hsnCode ?? "996331",
          sortOrder: input.sortOrder ?? 0, slots: json(input.slots),
        },
      });
      return { id: c.id };
    });
  }

  async updateCombo(user: AuthUser, brandId: string, id: string, input: MasterComboInput) {
    await this.requireMaster(user, brandId, "masterCombo", id);
    await this.requireMaster(user, brandId, "masterCategory", input.categoryId);
    await this.checkComboItems(user, brandId, input);
    return this.edit(user.tenantId, brandId, async (tx) => {
      await tx.masterCombo.update({
        where: { id },
        data: {
          categoryId: input.categoryId, name: input.name, price: input.price, isVeg: input.isVeg,
          taxRate: input.taxRate, hsnCode: input.hsnCode, sortOrder: input.sortOrder, slots: json(input.slots),
        },
      });
      return { id };
    });
  }

  async deleteCombo(user: AuthUser, brandId: string, id: string) {
    await this.requireMaster(user, brandId, "masterCombo", id);
    return this.edit(user.tenantId, brandId, async (tx) => {
      await tx.masterCombo.update({ where: { id }, data: { deletedAt: new Date() } });
      return { id };
    });
  }

  /**
   * Migration path: seed an EMPTY master menu from an existing outlet's menu and
   * link that outlet's rows to it, so the outlet starts in sync. Other outlets
   * adopt same-named rows on their first publish (ADOPTED_BY_NAME).
   */
  async importFromOutlet(user: AuthUser, brandId: string, outletId: string) {
    await this.requireBrand(user, brandId);
    const outlet = await this.requireBrandOutlet(user, brandId, outletId);
    const tenantId = user.tenantId;
    const existing = await this.prisma.masterCategory.count({ where: { tenantId, brandId, deletedAt: null } });
    if (existing > 0) throw new ConflictException("The master menu already has content; import works on an empty master only");

    return this.edit(tenantId, brandId, async (tx, version) => {
      const [cats, groups, combos, stations] = await Promise.all([
        tx.menuCategory.findMany({
          where: { tenantId, outletId, deletedAt: null },
          include: { items: { where: { deletedAt: null }, include: { variations: true, addonGroups: true } } },
        }),
        tx.addonGroup.findMany({ where: { tenantId, outletId }, include: { addons: true } }),
        tx.combo.findMany({ where: { tenantId, outletId, deletedAt: null }, include: { slots: { include: { options: true } } } }),
        tx.station.findMany({ where: { tenantId, outletId } }),
      ]);
      const groupMap = new Map<string, string>();
      for (const g of groups) {
        const mg = await tx.masterAddonGroup.create({
          data: {
            tenantId, brandId, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect,
            addons: json(g.addons.map((a) => ({ name: a.name, price: Number(a.price) }))),
          },
        });
        groupMap.set(g.id, mg.id);
        await tx.addonGroup.update({ where: { id: g.id }, data: { masterAddonGroupId: mg.id } });
      }
      const itemMap = new Map<string, string>();
      const catMap = new Map<string, string>();
      let items = 0;
      for (const c of cats) {
        const mc = await tx.masterCategory.create({
          data: {
            tenantId, brandId, name: c.name, sortOrder: c.sortOrder,
            stationName: stations.find((s) => s.id === c.stationId)?.name ?? null,
          },
        });
        catMap.set(c.id, mc.id);
        await tx.menuCategory.update({ where: { id: c.id }, data: { masterCategoryId: mc.id } });
        for (const i of c.items) {
          const mi = await tx.masterItem.create({
            data: {
              tenantId, brandId, categoryId: mc.id, name: i.name, shortCode: i.shortCode, price: i.price,
              isVeg: i.isVeg, taxRate: i.taxRate, hsnCode: i.hsnCode, sortOrder: i.sortOrder,
              availableStart: i.availableStart, availableEnd: i.availableEnd,
              variations: json(i.variations.map((v) => ({ name: v.name, price: Number(v.price) }))),
              addonGroupIds: json(i.addonGroups.map((g) => groupMap.get(g.addonGroupId)).filter(Boolean)),
              nameTranslations: (i.nameTranslations ?? Prisma.DbNull) as Prisma.InputJsonValue,
            },
          });
          itemMap.set(i.id, mi.id);
          await tx.item.update({ where: { id: i.id }, data: { masterItemId: mi.id, masterVersion: mi.version } });
          items++;
        }
      }
      for (const c of combos) {
        const mcId = catMap.get(c.categoryId);
        if (!mcId) continue;
        const slots = [...c.slots]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => ({
            name: s.name,
            options: s.options
              .filter((o) => itemMap.has(o.itemId))
              .map((o) => ({ masterItemId: itemMap.get(o.itemId)!, priceDelta: Number(o.priceDelta), isDefault: o.isDefault })),
          }));
        if (slots.some((s) => s.options.length === 0)) continue;
        const mc = await tx.masterCombo.create({
          data: {
            tenantId, brandId, categoryId: mcId, name: c.name, price: c.price, isVeg: c.isVeg, taxRate: c.taxRate,
            hsnCode: c.hsnCode, sortOrder: c.sortOrder, slots: json(slots),
          },
        });
        await tx.combo.update({ where: { id: c.id }, data: { masterComboId: mc.id } });
      }
      // The source outlet already matches the new master.
      await tx.outletMenuSync.upsert({
        where: { outletId: outlet.id },
        create: { tenantId, brandId, outletId: outlet.id, publishedVersion: version, status: "IN_SYNC", lastPublishedAt: new Date() },
        update: { brandId, publishedVersion: version, status: "IN_SYNC", lastPublishedAt: new Date(), lastError: null },
      });
      return { categories: cats.length, items, addonGroups: groups.length };
    }, true);
  }

  // ---------- publish ----------

  async preview(user: AuthUser, brandId: string, outletIds: string[]): Promise<PublishPlanDto> {
    await this.requireBrand(user, brandId);
    const outlets = await this.requireBrandOutlets(user, brandId, outletIds);
    const menu = await this.prisma.masterMenu.findUnique({ where: { brandId } });
    const plans = [];
    for (const o of outlets) {
      plans.push(
        await syncOutlet(this.prisma as unknown as Tx, { tenantId: user.tenantId, brandId, outletId: o.id, outletName: o.name }, false),
      );
    }
    return { version: menu?.version ?? 0, outlets: plans };
  }

  async publish(user: AuthUser, brandId: string, outletIds: string[]): Promise<PublishPlanDto> {
    await this.requireBrand(user, brandId);
    const outlets = await this.requireBrandOutlets(user, brandId, outletIds);
    return this.publishTo(user.tenantId, brandId, outlets, user.id);
  }

  /**
   * Each outlet publishes in its own transaction holding the brand's master-menu
   * row lock, so a concurrent master edit (which bumps the version under the same
   * lock) can't interleave and the recorded publishedVersion is exactly what was
   * applied. One outlet failing is recorded as FAILED without blocking the rest.
   */
  private async publishTo(tenantId: string, brandId: string, outlets: { id: string; name: string }[], userId: string | null) {
    await this.ensureMasterMenu(tenantId, brandId);
    const results = [];
    let version = 0;
    for (const o of outlets) {
      try {
        const plan = await this.prisma.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<{ version: number }[]>`
              SELECT version FROM master_menus WHERE "brandId" = ${brandId} AND "tenantId" = ${tenantId} FOR UPDATE`;
            version = rows[0]?.version ?? 0;
            const p = await syncOutlet(tx, { tenantId, brandId, outletId: o.id, outletName: o.name }, true);
            await tx.outletMenuSync.upsert({
              where: { outletId: o.id },
              create: { tenantId, brandId, outletId: o.id, publishedVersion: version, status: "IN_SYNC", lastPublishedAt: new Date() },
              update: { brandId, publishedVersion: version, status: "IN_SYNC", lastPublishedAt: new Date(), lastError: null },
            });
            return p;
          },
          { timeout: 60_000 },
        );
        results.push(plan);
        this.realtime.notifyOutlet(o.id);
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        this.logger.warn(`publish to ${o.id} failed: ${message}`);
        await this.prisma.outletMenuSync.upsert({
          where: { outletId: o.id },
          create: { tenantId, brandId, outletId: o.id, status: "FAILED", lastError: message },
          update: { status: "FAILED", lastError: message },
        });
        results.push({
          outletId: o.id, outletName: o.name, ops: [], conflicts: 0,
          counts: { CREATE: 0, UPDATE: 0, LINK: 0, REMOVE: 0, DETACH: 0, UNCHANGED: 0 },
          error: message,
        });
      }
    }
    await this.prisma.menuPublication.create({
      data: {
        tenantId, brandId, version, publishedById: userId, outletIds: json(outlets.map((o) => o.id)),
        summary: json(results.map((r) => ({ outletId: r.outletId, counts: r.counts, conflicts: r.conflicts }))),
      },
    });
    return { version, outlets: results };
  }

  async publications(user: AuthUser, brandId: string) {
    await this.requireBrand(user, brandId);
    const rows = await this.prisma.menuPublication.findMany({
      where: { tenantId: user.tenantId, brandId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map((r) => ({ id: r.id, version: r.version, createdAt: r.createdAt.toISOString(), summary: r.summary }));
  }

  // ---------- outlets ----------

  /** Open a new outlet under a brand (plan-limited) and optionally publish the master menu to it. */
  async createOutlet(user: AuthUser, brandId: string, input: CreateChainOutletInput) {
    await this.requireBrand(user, brandId);
    const outlet = await this.prisma.outlet.create({
      data: {
        tenantId: user.tenantId, brandId, name: input.name, address: input.address ?? null,
        userOutlets: { create: [{ userId: user.id }] },
      },
    });
    // Owners ("*") see every outlet; give them access to the new one too.
    const owners = await this.prisma.user.findMany({
      where: { tenantId: user.tenantId, isActive: true, id: { not: user.id } },
      include: { role: true },
    });
    const ownerIds = owners.filter((u) => Array.isArray(u.role.permissions) && (u.role.permissions as string[]).includes("*"));
    if (ownerIds.length) {
      await this.prisma.userOutlet.createMany({
        data: ownerIds.map((u) => ({ userId: u.id, outletId: outlet.id })),
        skipDuplicates: true,
      });
    }
    let published = false;
    if (input.publishMenu) {
      const hasMaster = await this.prisma.masterCategory.count({ where: { tenantId: user.tenantId, brandId, deletedAt: null } });
      if (hasMaster) {
        await this.publishTo(user.tenantId, brandId, [{ id: outlet.id, name: outlet.name }], user.id);
        published = true;
      }
    }
    return { id: outlet.id, name: outlet.name, published };
  }

  // ---------- outlet overrides (outlet managers) ----------

  async overrides(user: AuthUser, outletId: string): Promise<MasterOverrideDto[]> {
    const outlet = await this.requireOutlet(user, outletId);
    const [items, overrides] = await Promise.all([
      this.prisma.masterItem.findMany({
        where: { tenantId: user.tenantId, brandId: outlet.brandId, deletedAt: null, category: { deletedAt: null } },
        include: { category: true },
        orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
      }),
      this.prisma.masterItemOverride.findMany({ where: { tenantId: user.tenantId, outletId } }),
    ]);
    const by = new Map(overrides.map((o) => [o.masterItemId, o]));
    return items.map((i) => {
      const o = by.get(i.id);
      return {
        masterItemId: i.id,
        name: i.name,
        categoryName: i.category.name,
        masterPrice: Number(i.price),
        price: o?.price != null ? Number(o.price) : null,
        inStock: o?.inStock ?? null,
        isHidden: o?.isHidden ?? false,
        effectivePrice: resolveMasterItem(i, o).price,
      };
    });
  }

  /**
   * Set (or clear, when all fields are default) an outlet override, and apply it
   * to the outlet's linked row right away — no brand publish needed for an
   * outlet's own price / availability / visibility.
   */
  async setOverride(user: AuthUser, outletId: string, masterItemId: string, input: MasterOverrideInput) {
    const outlet = await this.requireOutlet(user, outletId);
    const item = await this.prisma.masterItem.findFirst({
      where: { id: masterItemId, tenantId: user.tenantId, brandId: outlet.brandId, deletedAt: null },
    });
    if (!item) throw new NotFoundException("Master item not found");
    const cleared = input.price === null && input.inStock === null && !input.isHidden;
    await this.prisma.$transaction(async (tx) => {
      if (cleared) {
        await tx.masterItemOverride.deleteMany({ where: { outletId, masterItemId } });
      } else {
        await tx.masterItemOverride.upsert({
          where: { outletId_masterItemId: { outletId, masterItemId } },
          create: { tenantId: user.tenantId, outletId, masterItemId, price: input.price, inStock: input.inStock, isHidden: input.isHidden },
          update: { price: input.price, inStock: input.inStock, isHidden: input.isHidden },
        });
      }
      const linked = await tx.item.findFirst({ where: { tenantId: user.tenantId, outletId, masterItemId } });
      if (linked) {
        const target = resolveMasterItem(item, cleared ? null : input);
        await tx.item.update({
          where: { id: linked.id },
          data: {
            price: target.price,
            inStock: target.inStock ?? undefined,
            // Un-hiding only restores rows hidden by an override, never items removed from the master.
            deletedAt: target.hidden ? (linked.deletedAt ?? new Date()) : linked.deletedAt && !item.deletedAt ? null : undefined,
          },
        });
      }
    });
    this.realtime.notifyOutlet(outletId);
    return { masterItemId, cleared };
  }

  // ---------- helpers ----------

  /** Run a master edit in a transaction and bump the brand's master version under its row lock. */
  private async edit<T>(tenantId: string, brandId: string, fn: (tx: Tx, version: number) => Promise<T>, long = false): Promise<T> {
    await this.ensureMasterMenu(tenantId, brandId);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM master_menus WHERE "brandId" = ${brandId} AND "tenantId" = ${tenantId} FOR UPDATE`;
        const menu = await tx.masterMenu.update({ where: { brandId }, data: { version: { increment: 1 } } });
        return fn(tx, menu.version);
      },
      long ? { timeout: 60_000 } : undefined,
    );
  }

  private async ensureMasterMenu(tenantId: string, brandId: string) {
    await this.prisma.masterMenu.upsert({ where: { brandId }, update: {}, create: { tenantId, brandId, version: 0 } });
  }

  private async requireBrand(user: AuthUser, brandId: string) {
    const brand = await this.prisma.brand.findFirst({ where: { id: brandId, tenantId: user.tenantId } });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  private async requireOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
    const outlet = await this.prisma.outlet.findFirst({ where: { id: outletId, tenantId: user.tenantId } });
    if (!outlet) throw new NotFoundException("Outlet not found");
    return outlet;
  }

  private async requireBrandOutlet(user: AuthUser, brandId: string, outletId: string) {
    const outlet = await this.requireOutlet(user, outletId);
    if (outlet.brandId !== brandId) throw new ForbiddenException("Outlet belongs to another brand");
    return outlet;
  }

  private async requireBrandOutlets(user: AuthUser, brandId: string, outletIds: string[]) {
    const out = [];
    for (const id of [...new Set(outletIds)]) out.push(await this.requireBrandOutlet(user, brandId, id));
    return out;
  }

  private async requireMaster(
    user: AuthUser,
    brandId: string,
    model: "masterCategory" | "masterItem" | "masterAddonGroup" | "masterCombo",
    id: string,
  ) {
    const where = { id, tenantId: user.tenantId, brandId, deletedAt: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (this.prisma[model] as any).findFirst({ where, select: { id: true } });
    if (!row) throw new NotFoundException("Not found");
  }

  private async checkAddonGroups(user: AuthUser, brandId: string, ids: string[]) {
    if (!ids.length) return;
    const n = await this.prisma.masterAddonGroup.count({
      where: { id: { in: ids }, tenantId: user.tenantId, brandId, deletedAt: null },
    });
    if (n !== new Set(ids).size) throw new NotFoundException("Add-on group not found");
  }

  private async checkComboItems(user: AuthUser, brandId: string, input: MasterComboInput) {
    const ids = [...new Set(input.slots.flatMap((s) => s.options.map((o) => o.masterItemId)))];
    const n = await this.prisma.masterItem.count({ where: { id: { in: ids }, tenantId: user.tenantId, brandId, deletedAt: null } });
    if (n !== ids.length) throw new NotFoundException("Combo option item not found");
  }

  private itemDto(i: Prisma.MasterItemGetPayload<object>) {
    return {
      id: i.id,
      categoryId: i.categoryId,
      name: i.name,
      shortCode: i.shortCode,
      price: Number(i.price),
      isVeg: i.isVeg,
      taxRate: Number(i.taxRate),
      hsnCode: i.hsnCode,
      sortOrder: i.sortOrder,
      availableStart: i.availableStart,
      availableEnd: i.availableEnd,
      variations: (i.variations as { name: string; price: number }[]) ?? [],
      addonGroupIds: (i.addonGroupIds as string[]) ?? [],
      nameTranslations: (i.nameTranslations as Record<string, string> | null) ?? null,
      version: i.version,
    };
  }
}
