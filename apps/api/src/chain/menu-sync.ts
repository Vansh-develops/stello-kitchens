import { Prisma } from "@prisma/client";
import type { OutletPublishPlanDto, PublishAction, PublishOpDto } from "@stello/shared";

/**
 * Brand master menu → outlet menu synchronisation.
 *
 * One code path computes the diff preview AND applies it: `syncOutlet` walks the
 * master menu, compares each entity with the outlet's linked row and records an
 * op; when `apply` is true it also performs the write. Preview and publish can
 * therefore never disagree.
 *
 * Conflict rules (documented in the op's `conflict` field when they fire):
 *  - OVERRIDE_KEPT: an outlet price / availability / hidden override always wins
 *    over the master value; the master change is applied around it.
 *  - LOCAL_EDIT_OVERWRITTEN: master-owned fields (name, category, price, tax,
 *    HSN, variants, add-ons, timings, translations) edited locally on a linked
 *    item are reset to the master — outlets customise via overrides instead.
 *  - ADOPTED_BY_NAME: an unlinked outlet row with the same name (and, for items,
 *    in the matching category) is linked instead of creating a duplicate — this
 *    is the migration path for outlets that predate the master menu.
 *  - OUTLET_ITEMS_KEPT: removing a master category whose outlet copy still holds
 *    outlet-only items detaches the category instead of deleting it.
 *  - COMBO_UNAVAILABLE: a combo whose slot has no orderable item at this outlet
 *    (all options hidden) is withdrawn from the outlet.
 * Outlet-only rows (no master link) are never modified or removed, and the
 * outlet's own in-stock toggle is left alone unless an availability override is set.
 */

type Db = Prisma.TransactionClient;

interface MasterVariation { name: string; price: number }
interface MasterAddon { name: string; price: number }
interface MasterSlot { name: string; options: { masterItemId: string; priceDelta: number; isDefault: boolean }[] }

export interface OverrideLike {
  price: Prisma.Decimal | number | null;
  inStock: boolean | null;
  isHidden: boolean;
}

export interface MasterItemLike {
  id: string;
  name: string;
  shortCode: string | null;
  price: Prisma.Decimal | number;
  isVeg: boolean;
  taxRate: Prisma.Decimal | number;
  hsnCode: string | null;
  sortOrder: number;
  availableStart: string | null;
  availableEnd: string | null;
  nameTranslations: Prisma.JsonValue | null;
}

/** The values an outlet row should carry for a master item, after its override. */
export interface ResolvedItem {
  name: string;
  shortCode: string | null;
  price: number;
  isVeg: boolean;
  taxRate: number;
  hsnCode: string | null;
  sortOrder: number;
  availableStart: string | null;
  availableEnd: string | null;
  nameTranslations: Record<string, string> | null;
  hidden: boolean;
  inStock: boolean | null; // null = keep the outlet's own toggle
}

/** Override resolution: null override fields inherit from the master item. */
export function resolveMasterItem(master: MasterItemLike, override?: OverrideLike | null): ResolvedItem {
  return {
    name: master.name,
    shortCode: master.shortCode,
    price: override?.price != null ? Number(override.price) : Number(master.price),
    isVeg: master.isVeg,
    taxRate: Number(master.taxRate),
    hsnCode: master.hsnCode,
    sortOrder: master.sortOrder,
    availableStart: master.availableStart,
    availableEnd: master.availableEnd,
    nameTranslations: asTranslations(master.nameTranslations),
    hidden: override?.isHidden ?? false,
    inStock: override?.inStock ?? null,
  };
}

function asTranslations(v: Prisma.JsonValue | null): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string" && val.trim()) out[k] = val;
  return Object.keys(out).length ? out : null;
}

function jsonArray<T>(v: Prisma.JsonValue | null): T[] {
  return Array.isArray(v) ? (v as unknown as T[]) : [];
}

const norm = (s: string) => s.trim().toLowerCase();
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sortedJson = (v: Record<string, string> | null) =>
  v ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : null;

export interface SyncContext {
  tenantId: string;
  brandId: string;
  outletId: string;
  outletName: string;
}

export async function syncOutlet(db: Db, ctx: SyncContext, apply: boolean): Promise<OutletPublishPlanDto> {
  const { tenantId, brandId, outletId } = ctx;
  const ops: PublishOpDto[] = [];
  const op = (o: Omit<PublishOpDto, "changes" | "conflict"> & Partial<Pick<PublishOpDto, "changes" | "conflict">>) =>
    ops.push({ changes: [], conflict: null, ...o });
  const placeholder = (masterId: string) => `new:${masterId}`;

  const [mCats, mItems, mGroups, mCombos, overrides, oCats, oItems, oGroups, oCombos, stations] = await Promise.all([
    db.masterCategory.findMany({ where: { tenantId, brandId }, orderBy: { sortOrder: "asc" } }),
    db.masterItem.findMany({ where: { tenantId, brandId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    db.masterAddonGroup.findMany({ where: { tenantId, brandId } }),
    db.masterCombo.findMany({ where: { tenantId, brandId } }),
    db.masterItemOverride.findMany({ where: { tenantId, outletId } }),
    db.menuCategory.findMany({ where: { tenantId, outletId } }),
    db.item.findMany({
      where: { tenantId, outletId },
      include: { variations: true, addonGroups: true },
    }),
    db.addonGroup.findMany({ where: { tenantId, outletId }, include: { addons: true } }),
    db.combo.findMany({ where: { tenantId, outletId }, include: { slots: { include: { options: true } } } }),
    db.station.findMany({ where: { tenantId, outletId } }),
  ]);
  const overrideBy = new Map(overrides.map((o) => [o.masterItemId, o]));

  // ---------- Add-on groups ----------
  const groupMap = new Map<string, string>(); // master group id → outlet group id
  const claimedGroups = new Set<string>();
  for (const mg of mGroups) {
    const linked = oGroups.find((g) => g.masterAddonGroupId === mg.id);
    if (mg.deletedAt) {
      if (linked) {
        op({ entity: "ADDON_GROUP", action: "REMOVE", masterId: mg.id, outletRowId: linked.id, name: linked.name });
        if (apply) {
          await db.itemAddonGroup.deleteMany({ where: { addonGroupId: linked.id } });
          await db.addon.deleteMany({ where: { groupId: linked.id } });
          await db.addonGroup.delete({ where: { id: linked.id } });
        }
      }
      continue;
    }
    const addons = jsonArray<MasterAddon>(mg.addons).map((a) => ({ name: a.name, price: Number(a.price) }));
    const adopt = linked
      ? null
      : oGroups.find((g) => !g.masterAddonGroupId && !claimedGroups.has(g.id) && norm(g.name) === norm(mg.name));
    const row = linked ?? adopt;
    if (!row) {
      const id = apply
        ? (
            await db.addonGroup.create({
              data: {
                tenantId, outletId, name: mg.name, minSelect: mg.minSelect, maxSelect: mg.maxSelect,
                masterAddonGroupId: mg.id, addons: { create: addons },
              },
            })
          ).id
        : placeholder(mg.id);
      groupMap.set(mg.id, id);
      op({ entity: "ADDON_GROUP", action: "CREATE", masterId: mg.id, outletRowId: null, name: mg.name });
      continue;
    }
    claimedGroups.add(row.id);
    groupMap.set(mg.id, row.id);
    const current = row.addons.map((a) => ({ name: a.name, price: Number(a.price) }));
    const changes: PublishOpDto["changes"] = [];
    if (row.name !== mg.name) changes.push({ field: "name", from: row.name, to: mg.name });
    if (row.minSelect !== mg.minSelect) changes.push({ field: "minSelect", from: row.minSelect, to: mg.minSelect });
    if (row.maxSelect !== mg.maxSelect) changes.push({ field: "maxSelect", from: row.maxSelect, to: mg.maxSelect });
    if (!same(current, addons)) changes.push({ field: "addons", from: current, to: addons });
    const action: PublishAction = adopt ? "LINK" : changes.length ? "UPDATE" : "UNCHANGED";
    op({
      entity: "ADDON_GROUP", action, masterId: mg.id, outletRowId: row.id, name: mg.name, changes,
      conflict: adopt ? { rule: "ADOPTED_BY_NAME", message: "Existing outlet add-on group linked to the master" } : null,
    });
    if (apply && action !== "UNCHANGED") {
      await db.addonGroup.update({
        where: { id: row.id },
        data: { name: mg.name, minSelect: mg.minSelect, maxSelect: mg.maxSelect, masterAddonGroupId: mg.id },
      });
      if (!same(current, addons)) {
        await db.addon.deleteMany({ where: { groupId: row.id } });
        await db.addon.createMany({ data: addons.map((a) => ({ groupId: row.id, ...a })) });
      }
    }
  }

  // ---------- Categories ----------
  const catMap = new Map<string, string>(); // master category id → outlet category id
  const liveMasterCats = new Set(mCats.filter((c) => !c.deletedAt).map((c) => c.id));
  const claimedCats = new Set<string>();
  const stationByName = new Map(stations.map((s) => [norm(s.name), s.id]));
  for (const mc of mCats) {
    const linked = oCats.find((c) => c.masterCategoryId === mc.id);
    if (mc.deletedAt) {
      if (linked && !linked.deletedAt) {
        const outletOnly = oItems.filter((i) => i.categoryId === linked.id && !i.masterItemId && !i.deletedAt).length;
        if (outletOnly > 0) {
          op({
            entity: "CATEGORY", action: "DETACH", masterId: mc.id, outletRowId: linked.id, name: linked.name,
            conflict: { rule: "OUTLET_ITEMS_KEPT", message: `${outletOnly} outlet-only item(s) keep the category alive` },
          });
          if (apply) await db.menuCategory.update({ where: { id: linked.id }, data: { masterCategoryId: null } });
        } else {
          op({ entity: "CATEGORY", action: "REMOVE", masterId: mc.id, outletRowId: linked.id, name: linked.name });
          if (apply) await db.menuCategory.update({ where: { id: linked.id }, data: { deletedAt: new Date() } });
        }
      }
      continue;
    }
    const stationId = mc.stationName ? stationByName.get(norm(mc.stationName)) : undefined;
    const adopt = linked
      ? null
      : oCats.find((c) => !c.masterCategoryId && !c.deletedAt && !claimedCats.has(c.id) && norm(c.name) === norm(mc.name));
    const row = linked ?? adopt;
    if (!row) {
      const id = apply
        ? (
            await db.menuCategory.create({
              data: {
                tenantId, outletId, name: mc.name, sortOrder: mc.sortOrder, masterCategoryId: mc.id,
                stationId: stationId ?? null,
              },
            })
          ).id
        : placeholder(mc.id);
      catMap.set(mc.id, id);
      op({ entity: "CATEGORY", action: "CREATE", masterId: mc.id, outletRowId: null, name: mc.name });
      continue;
    }
    claimedCats.add(row.id);
    catMap.set(mc.id, row.id);
    const changes: PublishOpDto["changes"] = [];
    if (row.name !== mc.name) changes.push({ field: "name", from: row.name, to: mc.name });
    if (row.sortOrder !== mc.sortOrder) changes.push({ field: "sortOrder", from: row.sortOrder, to: mc.sortOrder });
    if (row.deletedAt) changes.push({ field: "restored", from: true, to: false });
    if (stationId && row.stationId !== stationId) changes.push({ field: "station", from: row.stationId, to: mc.stationName });
    const action: PublishAction = adopt ? "LINK" : changes.length ? "UPDATE" : "UNCHANGED";
    op({
      entity: "CATEGORY", action, masterId: mc.id, outletRowId: row.id, name: mc.name, changes,
      conflict: adopt ? { rule: "ADOPTED_BY_NAME", message: "Existing outlet category linked to the master" } : null,
    });
    if (apply && action !== "UNCHANGED") {
      await db.menuCategory.update({
        where: { id: row.id },
        data: {
          name: mc.name, sortOrder: mc.sortOrder, masterCategoryId: mc.id, deletedAt: null,
          stationId: stationId ?? undefined,
        },
      });
    }
  }

  // ---------- Items ----------
  const itemMap = new Map<string, string>(); // master item id → live outlet item id
  const claimedItems = new Set<string>();
  for (const mi of mItems) {
    const linked = oItems.find((i) => i.masterItemId === mi.id);
    const removedFromMaster = !!mi.deletedAt || !liveMasterCats.has(mi.categoryId);
    const override = overrideBy.get(mi.id);
    const target = resolveMasterItem(mi, override);

    if (removedFromMaster || target.hidden) {
      if (linked && !linked.deletedAt) {
        op({
          entity: "ITEM", action: "REMOVE", masterId: mi.id, outletRowId: linked.id, name: linked.name,
          changes: removedFromMaster ? [] : [{ field: "hidden", from: false, to: true }],
          conflict: !removedFromMaster ? { rule: "OVERRIDE_KEPT", message: "Hidden at this outlet by override" } : null,
        });
        if (apply) await db.item.update({ where: { id: linked.id }, data: { deletedAt: new Date(), masterVersion: mi.version } });
      }
      continue;
    }

    const categoryId = catMap.get(mi.categoryId)!;
    const variations = jsonArray<MasterVariation>(mi.variations).map((v) => ({ name: v.name, price: Number(v.price) }));
    const groupIds = jsonArray<string>(mi.addonGroupIds).map((g) => groupMap.get(g)).filter((g): g is string => !!g).sort();
    const adopt = linked
      ? null
      : oItems.find(
          (i) =>
            !i.masterItemId && !i.deletedAt && !claimedItems.has(i.id) &&
            norm(i.name) === norm(mi.name) && i.categoryId === categoryId,
        );
    const row = linked ?? adopt;

    const overrideNote =
      override && (override.price != null || override.inStock != null)
        ? {
            rule: "OVERRIDE_KEPT",
            message:
              override.price != null && Number(override.price) !== Number(mi.price)
                ? `Outlet price ₹${Number(override.price)} kept (master ₹${Number(mi.price)})`
                : "Outlet availability override kept",
          }
        : null;

    if (!row) {
      let id = placeholder(mi.id);
      if (apply) {
        const created = await db.item.create({
          data: {
            tenantId, outletId, categoryId, name: target.name, shortCode: target.shortCode, price: target.price,
            isVeg: target.isVeg, taxRate: target.taxRate, hsnCode: target.hsnCode, sortOrder: target.sortOrder,
            availableStart: target.availableStart, availableEnd: target.availableEnd,
            nameTranslations: target.nameTranslations ?? Prisma.DbNull,
            inStock: target.inStock ?? true, masterItemId: mi.id, masterVersion: mi.version,
            variations: { create: variations },
            addonGroups: { create: groupIds.map((addonGroupId) => ({ addonGroupId })) },
          },
        });
        id = created.id;
      }
      itemMap.set(mi.id, id);
      op({ entity: "ITEM", action: "CREATE", masterId: mi.id, outletRowId: null, name: mi.name, conflict: overrideNote });
      continue;
    }

    claimedItems.add(row.id);
    itemMap.set(mi.id, row.id);
    const currentVariations = row.variations.map((v) => ({ name: v.name, price: Number(v.price) }));
    const currentGroups = row.addonGroups.map((g) => g.addonGroupId).sort();
    const compare: [string, unknown, unknown][] = [
      ["category", row.categoryId, categoryId],
      ["name", row.name, target.name],
      ["shortCode", row.shortCode, target.shortCode],
      ["price", Number(row.price), target.price],
      ["isVeg", row.isVeg, target.isVeg],
      ["taxRate", Number(row.taxRate), target.taxRate],
      ["hsnCode", row.hsnCode, target.hsnCode],
      ["sortOrder", row.sortOrder, target.sortOrder],
      ["availableStart", row.availableStart, target.availableStart],
      ["availableEnd", row.availableEnd, target.availableEnd],
      ["nameTranslations", sortedJson(asTranslations(row.nameTranslations)), sortedJson(target.nameTranslations)],
      ["variations", currentVariations, variations],
      // Placeholder ids only occur in a dry run for groups that don't exist yet.
      ["addons", currentGroups, groupIds],
    ];
    const changes = compare.filter(([, a, b]) => !same(a, b)).map(([field, from, to]) => ({ field, from, to }));
    if (row.deletedAt) changes.push({ field: "hidden", from: true, to: false });
    if (target.inStock !== null && row.inStock !== target.inStock)
      changes.push({ field: "inStock", from: row.inStock, to: target.inStock });

    const masterUnchanged = row.masterVersion === mi.version;
    const drift = !adopt && masterUnchanged && changes.some((c) => c.field !== "hidden" && c.field !== "inStock");
    const action: PublishAction = adopt ? "LINK" : changes.length ? "UPDATE" : "UNCHANGED";
    const conflict = adopt
      ? { rule: "ADOPTED_BY_NAME", message: "Existing outlet item linked to the master" }
      : drift
        ? { rule: "LOCAL_EDIT_OVERWRITTEN", message: "Local edits to master-owned fields will be reset" }
        : action !== "UNCHANGED"
          ? overrideNote
          : null;
    op({ entity: "ITEM", action, masterId: mi.id, outletRowId: row.id, name: mi.name, changes, conflict });

    if (apply && action === "UNCHANGED" && row.masterVersion !== mi.version) {
      // Master edited but nothing changes here (e.g. an override absorbs it): just record the version.
      await db.item.update({ where: { id: row.id }, data: { masterVersion: mi.version } });
    }
    if (apply && action !== "UNCHANGED") {
      await db.item.update({
        where: { id: row.id },
        data: {
          categoryId, name: target.name, shortCode: target.shortCode, price: target.price, isVeg: target.isVeg,
          taxRate: target.taxRate, hsnCode: target.hsnCode, sortOrder: target.sortOrder,
          availableStart: target.availableStart, availableEnd: target.availableEnd,
          nameTranslations: target.nameTranslations ?? Prisma.DbNull,
          inStock: target.inStock ?? undefined, deletedAt: null, masterItemId: mi.id, masterVersion: mi.version,
        },
      });
      if (!same(currentVariations, variations)) {
        await db.itemVariation.deleteMany({ where: { itemId: row.id } });
        if (variations.length) await db.itemVariation.createMany({ data: variations.map((v) => ({ itemId: row.id, ...v })) });
      }
      if (!same(currentGroups, groupIds)) {
        await db.itemAddonGroup.deleteMany({ where: { itemId: row.id } });
        if (groupIds.length)
          await db.itemAddonGroup.createMany({ data: groupIds.map((addonGroupId) => ({ itemId: row.id, addonGroupId })) });
      }
    }
  }

  // ---------- Combos ----------
  const claimedCombos = new Set<string>();
  for (const mc of mCombos) {
    const linked = oCombos.find((c) => c.masterComboId === mc.id);
    const removeLinked = async (rule: { rule: string; message: string } | null) => {
      if (!linked || linked.deletedAt) return;
      op({ entity: "COMBO", action: "REMOVE", masterId: mc.id, outletRowId: linked.id, name: linked.name, conflict: rule });
      if (apply) await db.combo.update({ where: { id: linked.id }, data: { deletedAt: new Date() } });
    };
    if (mc.deletedAt || !liveMasterCats.has(mc.categoryId)) {
      await removeLinked(null);
      continue;
    }
    // Resolve slot options to this outlet's items; hidden items drop out.
    const slots = jsonArray<MasterSlot>(mc.slots).map((s, idx) => ({
      name: s.name,
      sortOrder: idx,
      options: s.options
        .filter((o) => itemMap.has(o.masterItemId))
        .map((o) => ({ itemId: itemMap.get(o.masterItemId)!, priceDelta: Number(o.priceDelta ?? 0), isDefault: !!o.isDefault })),
    }));
    if (slots.some((s) => s.options.length === 0)) {
      await removeLinked({ rule: "COMBO_UNAVAILABLE", message: "A combo slot has no orderable item at this outlet" });
      continue;
    }
    const categoryId = catMap.get(mc.categoryId)!;
    const adopt = linked
      ? null
      : oCombos.find((c) => !c.masterComboId && !c.deletedAt && !claimedCombos.has(c.id) && norm(c.name) === norm(mc.name));
    const row = linked ?? adopt;
    const fields = {
      categoryId, name: mc.name, price: Number(mc.price), isVeg: mc.isVeg, taxRate: Number(mc.taxRate),
      hsnCode: mc.hsnCode, sortOrder: mc.sortOrder,
    };
    if (!row) {
      if (apply) {
        await db.combo.create({
          data: {
            tenantId, outletId, ...fields, masterComboId: mc.id,
            slots: {
              create: slots.map((s) => ({ name: s.name, sortOrder: s.sortOrder, options: { create: s.options } })),
            },
          },
        });
      }
      op({ entity: "COMBO", action: "CREATE", masterId: mc.id, outletRowId: null, name: mc.name });
      continue;
    }
    claimedCombos.add(row.id);
    const currentSlots = [...row.slots]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({
        name: s.name,
        sortOrder: s.sortOrder,
        options: s.options.map((o) => ({ itemId: o.itemId, priceDelta: Number(o.priceDelta), isDefault: o.isDefault })),
      }));
    const current = {
      categoryId: row.categoryId, name: row.name, price: Number(row.price), isVeg: row.isVeg,
      taxRate: Number(row.taxRate), hsnCode: row.hsnCode, sortOrder: row.sortOrder,
    };
    const changes: PublishOpDto["changes"] = (Object.keys(fields) as (keyof typeof fields)[])
      .filter((k) => !same(current[k], fields[k]))
      .map((k) => ({ field: k, from: current[k] as unknown, to: fields[k] as unknown }));
    if (!same(currentSlots, slots)) changes.push({ field: "slots", from: currentSlots, to: slots });
    if (row.deletedAt) changes.push({ field: "restored", from: true, to: false });
    const action: PublishAction = adopt ? "LINK" : changes.length ? "UPDATE" : "UNCHANGED";
    op({
      entity: "COMBO", action, masterId: mc.id, outletRowId: row.id, name: mc.name, changes,
      conflict: adopt ? { rule: "ADOPTED_BY_NAME", message: "Existing outlet combo linked to the master" } : null,
    });
    if (apply && action !== "UNCHANGED") {
      await db.combo.update({ where: { id: row.id }, data: { ...fields, masterComboId: mc.id, deletedAt: null } });
      if (!same(currentSlots, slots)) {
        await db.comboSlot.deleteMany({ where: { comboId: row.id } });
        for (const s of slots) {
          await db.comboSlot.create({
            data: { comboId: row.id, name: s.name, sortOrder: s.sortOrder, options: { create: s.options } },
          });
        }
      }
    }
  }

  const counts: Record<PublishAction, number> = { CREATE: 0, UPDATE: 0, LINK: 0, REMOVE: 0, DETACH: 0, UNCHANGED: 0 };
  for (const o of ops) counts[o.action]++;
  return {
    outletId,
    outletName: ctx.outletName,
    ops,
    counts,
    conflicts: ops.filter((o) => o.conflict).length,
  };
}
