import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  AuthUser,
  MenuCategoryDto,
  OrderRequestDto,
  OrderRequestStatusDto,
  PublicMenuDto,
  SubmitOrderRequestInput,
  TableQrDto,
  TokenBoardDto,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { CombosService } from "../combos/combos.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

// The item shape a diner submits, stored as JSON on the request row.
type SubmittedItem = {
  itemId: string;
  variationId?: string;
  addonIds?: string[];
  quantity: number;
  note?: string;
};

// A combo a diner submits, stored as JSON on the request row.
type SubmittedCombo = {
  comboId: string;
  quantity: number;
  selections?: { slotId: string; itemId: string }[];
  note?: string;
};

type ComboWithOptions = Prisma.ComboGetPayload<{
  include: { slots: { include: { options: { include: { item: true } } } } };
}>;

@Injectable()
export class ScanOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly combos: CombosService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ---------- Public (diner-facing, no auth) ----------

  /** Menu for a table's Scan & Order QR. */
  async menuForTable(token: string): Promise<PublicMenuDto> {
    const table = await this.prisma.diningTable.findUnique({
      where: { publicToken: token },
      include: { outlet: true },
    });
    if (!table) throw new NotFoundException("This QR code is no longer active");
    return {
      outletName: table.outlet.name,
      mode: "DINE_IN",
      tableName: table.name,
      categories: await this.buildMenu(table.outlet.tenantId, table.outletId),
    };
  }

  /** Menu for kiosk / self-service takeaway (outlet-level token). */
  async menuForOutlet(token: string): Promise<PublicMenuDto> {
    const outlet = await this.prisma.outlet.findUnique({ where: { publicToken: token } });
    if (!outlet) throw new NotFoundException("This kiosk link is no longer active");
    return {
      outletName: outlet.name,
      mode: "TAKEAWAY",
      tableName: null,
      categories: await this.buildMenu(outlet.tenantId, outlet.id),
    };
  }

  /** Diner submits a cart; a staff member must validate it before it fires. */
  async submitFromTable(token: string, input: SubmitOrderRequestInput): Promise<{ requestToken: string }> {
    const table = await this.prisma.diningTable.findUnique({
      where: { publicToken: token },
      include: { outlet: true },
    });
    if (!table) throw new NotFoundException("This QR code is no longer active");
    return this.createRequest({
      tenantId: table.outlet.tenantId,
      outletId: table.outletId,
      mode: "DINE_IN",
      tableId: table.id,
      input,
    });
  }

  async submitFromKiosk(token: string, input: SubmitOrderRequestInput): Promise<{ requestToken: string }> {
    const outlet = await this.prisma.outlet.findUnique({ where: { publicToken: token } });
    if (!outlet) throw new NotFoundException("This kiosk link is no longer active");
    return this.createRequest({
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      mode: "TAKEAWAY",
      tableId: null,
      input,
    });
  }

  /** Diner polls the fate of their submitted request. */
  async status(requestToken: string): Promise<OrderRequestStatusDto> {
    const req = await this.prisma.orderRequest.findUnique({ where: { token: requestToken } });
    if (!req) throw new NotFoundException("Order request not found");
    return { status: req.status as OrderRequestStatusDto["status"], tokenNumber: req.tokenNumber };
  }

  /** Public token-display board: which token numbers are cooking vs ready. */
  async board(outletToken: string): Promise<TokenBoardDto> {
    const outlet = await this.prisma.outlet.findUnique({ where: { publicToken: outletToken } });
    if (!outlet) throw new NotFoundException("Board link is no longer active");
    const reqs = await this.prisma.orderRequest.findMany({
      where: { outletId: outlet.id, status: "ACCEPTED", tokenNumber: { not: null }, orderId: { not: null } },
      orderBy: { tokenNumber: "asc" },
    });
    const orderIds = reqs.map((r) => r.orderId!).filter(Boolean);
    const orders = await this.prisma.order.findMany({
      where: { id: { in: orderIds } },
      include: { items: { select: { prepStatus: true } } },
    });
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const preparing: number[] = [];
    const ready: number[] = [];
    for (const r of reqs) {
      const order = orderById.get(r.orderId!);
      if (!order || order.status !== "OPEN" || order.items.length === 0) continue; // cleared once settled
      const allReady = order.items.every((i) => i.prepStatus === "READY");
      (allReady ? ready : preparing).push(r.tokenNumber!);
    }
    return { outletName: outlet.name, preparing, ready };
  }

  // ---------- Staff validation (authed) ----------

  async listPending(user: AuthUser, outletId: string): Promise<OrderRequestDto[]> {
    this.assertOutlet(user, outletId);
    const reqs = await this.prisma.orderRequest.findMany({
      where: { tenantId: user.tenantId, outletId, status: "PENDING" },
      include: { table: true },
      orderBy: { createdAt: "asc" },
    });
    // Resolve item names/prices from the current menu for a readable, priced queue.
    const itemIds = [
      ...new Set(reqs.flatMap((r) => (r.items as SubmittedItem[]).map((i) => i.itemId))),
    ];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      include: { variations: true, addonGroups: { include: { group: { include: { addons: true } } } } },
    });
    const itemMap = new Map(items.map((i) => [i.id, i]));

    const comboIds = [
      ...new Set(reqs.flatMap((r) => ((r.combos as SubmittedCombo[] | null) ?? []).map((c) => c.comboId))),
    ];
    const combos = comboIds.length
      ? await this.prisma.combo.findMany({
          where: { id: { in: comboIds } },
          include: { slots: { include: { options: { include: { item: true } } } } },
        })
      : [];
    const comboMap = new Map(combos.map((c) => [c.id, c]));
    return reqs.map((r) => this.toRequestDto(r, itemMap, comboMap));
  }

  async accept(user: AuthUser, requestId: string): Promise<OrderRequestDto> {
    const req = await this.requireRequest(user, requestId);
    if (req.status !== "PENDING") throw new BadRequestException("Request already decided");

    const result = await this.orders.ingestScanOrder({
      tenantId: user.tenantId,
      outletId: req.outletId,
      mode: req.mode as "DINE_IN" | "TAKEAWAY",
      tableId: req.tableId,
      items: (req.items as SubmittedItem[]).map((i) => ({
        itemId: i.itemId,
        variationId: i.variationId,
        addonIds: i.addonIds ?? [],
        quantity: i.quantity,
        note: i.note,
      })),
      combos: ((req.combos as SubmittedCombo[] | null) ?? []).map((c) => ({
        comboId: c.comboId,
        quantity: c.quantity,
        selections: c.selections ?? [],
        note: c.note,
      })),
      customerName: req.customerName,
      customerPhone: req.customerPhone,
    });

    // Assign the next token number for this outlet (monotonic display counter).
    const last = await this.prisma.orderRequest.aggregate({
      where: { outletId: req.outletId, tokenNumber: { not: null } },
      _max: { tokenNumber: true },
    });
    const tokenNumber = (last._max.tokenNumber ?? 0) + 1;

    const updated = await this.prisma.orderRequest.update({
      where: { id: req.id },
      data: { status: "ACCEPTED", orderId: result.orderId, tokenNumber, decidedAt: new Date() },
      include: { table: true },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: "SCAN_ORDER_ACCEPTED",
        entity: "order_request",
        entityId: req.id,
        data: { orderId: result.orderId, kotNumber: result.kotNumber, tokenNumber },
      },
    });
    this.realtime.notifyOutlet(req.outletId);
    return this.toRequestDto(updated, new Map());
  }

  async reject(user: AuthUser, requestId: string): Promise<OrderRequestDto> {
    const req = await this.requireRequest(user, requestId);
    if (req.status !== "PENDING") throw new BadRequestException("Request already decided");
    const updated = await this.prisma.orderRequest.update({
      where: { id: req.id },
      data: { status: "REJECTED", decidedAt: new Date() },
      include: { table: true },
    });
    this.realtime.notifyOutlet(req.outletId);
    return this.toRequestDto(updated, new Map());
  }

  /** Per-table Scan & Order QR targets for the dashboard. */
  async tableQrs(user: AuthUser, outletId: string): Promise<TableQrDto[]> {
    this.assertOutlet(user, outletId);
    const tables = await this.prisma.diningTable.findMany({
      where: { tenantId: user.tenantId, outletId },
      include: { area: true },
      orderBy: { name: "asc" },
    });
    return tables
      .filter((t) => t.publicToken)
      .map((t) => ({
        tableId: t.id,
        tableName: t.name,
        areaName: t.area.name,
        token: t.publicToken!,
      }));
  }

  /** The kiosk + token-display public tokens for this outlet (for dashboard links). */
  async outletPublicToken(user: AuthUser, outletId: string): Promise<{ token: string | null }> {
    this.assertOutlet(user, outletId);
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    return { token: outlet.publicToken };
  }

  // ---------- helpers ----------

  private async createRequest(params: {
    tenantId: string;
    outletId: string;
    mode: "DINE_IN" | "TAKEAWAY";
    tableId: string | null;
    input: SubmitOrderRequestInput;
  }): Promise<{ requestToken: string }> {
    // Validate every submitted item exists at this outlet and is in stock.
    const itemIds = [...new Set(params.input.items.map((i) => i.itemId))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, outletId: params.outletId, deletedAt: null },
    });
    const found = new Set(items.map((i) => i.id));
    for (const line of params.input.items) {
      const item = items.find((i) => i.id === line.itemId);
      if (!found.has(line.itemId)) throw new BadRequestException("An item is no longer on the menu");
      if (item && !item.inStock) throw new BadRequestException(`${item.name} is out of stock`);
    }

    // Validate every submitted combo exists at this outlet and is available.
    const combos = params.input.combos ?? [];
    if (combos.length) {
      const comboIds = [...new Set(combos.map((c) => c.comboId))];
      const rows = await this.prisma.combo.findMany({
        where: { id: { in: comboIds }, outletId: params.outletId, deletedAt: null },
      });
      const cmap = new Map(rows.map((c) => [c.id, c]));
      for (const c of combos) {
        const combo = cmap.get(c.comboId);
        if (!combo) throw new BadRequestException("A combo is no longer on the menu");
        if (!combo.inStock) throw new BadRequestException(`${combo.name} is unavailable`);
      }
    }

    const created = await this.prisma.orderRequest.create({
      data: {
        tenantId: params.tenantId,
        outletId: params.outletId,
        tableId: params.tableId,
        mode: params.mode,
        customerName: params.input.customerName ?? null,
        customerPhone: params.input.customerPhone ?? null,
        note: params.input.note ?? null,
        items: params.input.items as unknown as Prisma.InputJsonValue,
        combos: combos as unknown as Prisma.InputJsonValue,
      },
    });
    this.realtime.notifyOutlet(params.outletId);
    return { requestToken: created.token };
  }

  private async buildMenu(tenantId: string, outletId: string): Promise<MenuCategoryDto[]> {
    const categories = await this.prisma.menuCategory.findMany({
      where: { tenantId, outletId, deletedAt: null },
      orderBy: { sortOrder: "asc" },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: { name: "asc" },
          include: {
            variations: true,
            addonGroups: { include: { group: { include: { addons: true } } } },
          },
        },
      },
    });
    const combos = await this.combos.listDtos(tenantId, outletId);
    const combosByCategory = new Map<string, typeof combos>();
    for (const combo of combos) {
      const list = combosByCategory.get(combo.categoryId) ?? [];
      list.push(combo);
      combosByCategory.set(combo.categoryId, list);
    }
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      combos: combosByCategory.get(c.id) ?? [],
      items: c.items.map((i) => ({
        id: i.id,
        name: i.name,
        shortCode: i.shortCode,
        price: Number(i.price),
        isVeg: i.isVeg,
        inStock: i.inStock,
        taxRate: Number(i.taxRate),
        variations: i.variations.map((v) => ({ id: v.id, name: v.name, price: Number(v.price) })),
        addonGroups: i.addonGroups.map((ag) => ({
          id: ag.group.id,
          name: ag.group.name,
          minSelect: ag.group.minSelect,
          maxSelect: ag.group.maxSelect,
          addons: ag.group.addons.map((a) => ({ id: a.id, name: a.name, price: Number(a.price) })),
        })),
      })),
    }));
  }

  private toRequestDto(
    req: Prisma.OrderRequestGetPayload<{ include: { table: true } }>,
    itemMap: Map<string, Prisma.ItemGetPayload<{ include: { variations: true; addonGroups: { include: { group: { include: { addons: true } } } } } }>>,
    comboMap: Map<string, ComboWithOptions> = new Map(),
  ): OrderRequestDto {
    let total = 0;
    const items = (req.items as SubmittedItem[]).map((line) => {
      const item = itemMap.get(line.itemId);
      const variation = line.variationId
        ? item?.variations.find((v) => v.id === line.variationId)
        : undefined;
      const allAddons = item?.addonGroups.flatMap((ag) => ag.group.addons) ?? [];
      const addons = (line.addonIds ?? []).map((id) => allAddons.find((a) => a.id === id)).filter(Boolean);
      const base = variation ? Number(variation.price) : item ? Number(item.price) : 0;
      const addonSum = addons.reduce((s, a) => s + Number(a!.price), 0);
      total += (base + addonSum) * line.quantity;
      return {
        name: item?.name ?? "Item",
        variationName: variation?.name ?? null,
        addonNames: addons.map((a) => a!.name),
        quantity: line.quantity,
        note: line.note ?? null,
      };
    });

    // Combos render as line entries (name prefixed, chosen components as "addons").
    for (const line of (req.combos as SubmittedCombo[] | null) ?? []) {
      const combo = comboMap.get(line.comboId);
      if (!combo) {
        items.push({ name: "Combo", variationName: null, addonNames: [], quantity: line.quantity, note: line.note ?? null });
        continue;
      }
      let unit = Number(combo.price);
      const componentNames: string[] = [];
      for (const slot of combo.slots) {
        const sel = line.selections?.find((s) => s.slotId === slot.id);
        const option = (sel ? slot.options.find((o) => o.itemId === sel.itemId) : undefined)
          ?? slot.options.find((o) => o.isDefault)
          ?? slot.options[0];
        if (option) {
          unit += Number(option.priceDelta);
          componentNames.push(option.item.name);
        }
      }
      total += unit * line.quantity;
      items.push({
        name: `Combo · ${combo.name}`,
        variationName: null,
        addonNames: componentNames,
        quantity: line.quantity,
        note: line.note ?? null,
      });
    }

    return {
      id: req.id,
      mode: req.mode as OrderRequestDto["mode"],
      tableName: req.table?.name ?? null,
      customerName: req.customerName,
      customerPhone: req.customerPhone,
      note: req.note,
      status: req.status as OrderRequestDto["status"],
      tokenNumber: req.tokenNumber,
      createdAt: req.createdAt.toISOString(),
      items,
      total: Math.round(total * 100) / 100,
    };
  }

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  private async requireRequest(user: AuthUser, requestId: string) {
    const req = await this.prisma.orderRequest.findUnique({ where: { id: requestId } });
    if (!req || req.tenantId !== user.tenantId) throw new NotFoundException("Order request not found");
    this.assertOutlet(user, req.outletId);
    return req;
  }
}
