import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  AddItemsInput,
  AuthUser,
  ComboOrderInput,
  CreateOrderInput,
  OrderDto,
  OrderItemInput,
  SettleOrderInput,
  SyncedOrderInput,
} from "@stello/shared";
import { computeOrderTotals, evaluateCoupon, fromPaise, lineTotalPaise, toPaise } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { LoyaltyOtpService } from "../loyalty/loyalty-otp.service";

const orderInclude = {
  table: true,
  items: { include: { addons: true, kot: true } },
  kots: { include: { items: true }, orderBy: { kotNumber: "asc" as const } },
  payments: true,
};

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly loyaltyOtp: LoyaltyOtpService,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async create(user: AuthUser, input: CreateOrderInput): Promise<OrderDto> {
    this.assertOutlet(user, input.outletId);

    if (input.orderType === "DINE_IN") {
      if (!input.tableId) throw new BadRequestException("Dine-in orders need a table");
      const existing = await this.prisma.order.findFirst({
        where: { outletId: input.outletId, tableId: input.tableId, status: "OPEN" },
      });
      if (existing) throw new BadRequestException("Table already has an open order");
    }

    const orderId = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          tenantId: user.tenantId,
          outletId: input.outletId,
          orderType: input.orderType,
          tableId: input.orderType === "DINE_IN" ? input.tableId : null,
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          createdById: user.id,
        },
      });
      await this.punchItems(tx, user, order.id, input.outletId, input.items, input.combos);
      await this.recomputeTotals(tx, order.id);
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: "ORDER_CREATED",
          entity: "order",
          entityId: order.id,
          data: { orderType: input.orderType, itemCount: input.items.length, comboCount: input.combos.length },
        },
      });
      return order.id;
    });
    this.realtime.notifyOutlet(input.outletId);
    return this.getOne(user, orderId);
  }

  /**
   * Trusted server-side ingestion for aggregator orders (called by the connector).
   * Bypasses AuthUser/permission checks; reuses KOT + station + inventory + realtime.
   */
  async ingestAggregatorOrder(params: {
    tenantId: string;
    outletId: string;
    items: OrderItemInput[];
    customerName?: string | null;
    customerPhone?: string | null;
  }): Promise<{ orderId: string; kotNumber: number; total: number }> {
    const result = await this.prisma.$transaction((tx) => this.ingestAggregatorOrderTx(tx, params));
    this.realtime.notifyOutlet(params.outletId);
    return result;
  }

  /**
   * Core aggregator-order creation, on a caller-supplied transaction. The
   * connector wraps this together with its idempotency-key reservation in ONE
   * transaction, so a duplicate webhook loses the unique race and rolls back the
   * KOT + stock it would have created — no double-fire, no orphaned order.
   * Callers must fire `realtime.notifyOutlet(outletId)` after the tx commits.
   */
  async ingestAggregatorOrderTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      items: OrderItemInput[];
      customerName?: string | null;
      customerPhone?: string | null;
    },
  ): Promise<{ orderId: string; kotNumber: number; total: number }> {
    if (params.items.length === 0) throw new BadRequestException("No mappable items in order");
    const actor = { tenantId: params.tenantId, id: null };
    const order = await tx.order.create({
      data: {
        tenantId: params.tenantId,
        outletId: params.outletId,
        orderType: "DELIVERY",
        customerName: params.customerName ?? null,
        customerPhone: params.customerPhone ?? null,
      },
    });
    await this.punchItems(tx, actor, order.id, params.outletId, params.items);
    await this.recomputeTotals(tx, order.id);
    const withKot = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { kots: { orderBy: { kotNumber: "asc" }, take: 1 } },
    });
    return { orderId: order.id, kotNumber: withKot.kots[0]?.kotNumber ?? 0, total: Number(withKot.total) };
  }

  /**
   * Trusted ingestion for a staff-validated Scan & Order request. For dine-in it
   * adds to the table's running order if one is open (new KOT), otherwise opens a
   * new order; takeaway always opens a new one. Reuses the KOT/inventory/realtime path.
   */
  async ingestScanOrder(params: {
    tenantId: string;
    outletId: string;
    mode: "DINE_IN" | "TAKEAWAY";
    tableId?: string | null;
    items: OrderItemInput[];
    combos?: ComboOrderInput[];
    customerName?: string | null;
    customerPhone?: string | null;
  }): Promise<{ orderId: string; kotNumber: number; total: number }> {
    const combos = params.combos ?? [];
    if (params.items.length === 0 && combos.length === 0) {
      throw new BadRequestException("No items in request");
    }
    const actor = { tenantId: params.tenantId, id: null };
    const orderId = await this.prisma.$transaction(async (tx) => {
      let order =
        params.mode === "DINE_IN" && params.tableId
          ? await tx.order.findFirst({
              where: { outletId: params.outletId, tableId: params.tableId, status: "OPEN" },
            })
          : null;
      if (!order) {
        order = await tx.order.create({
          data: {
            tenantId: params.tenantId,
            outletId: params.outletId,
            orderType: params.mode === "DINE_IN" ? "DINE_IN" : "TAKEAWAY",
            tableId: params.mode === "DINE_IN" ? (params.tableId ?? null) : null,
            customerName: params.customerName ?? null,
            customerPhone: params.customerPhone ?? null,
          },
        });
      }
      await this.punchItems(tx, actor, order.id, params.outletId, params.items, combos);
      await this.recomputeTotals(tx, order.id);
      return order.id;
    });
    this.realtime.notifyOutlet(params.outletId);
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { kots: { orderBy: { kotNumber: "desc" }, take: 1 } },
    });
    return { orderId, kotNumber: order.kots[0]?.kotNumber ?? 0, total: Number(order.total) };
  }

  /**
   * Apply an order that was created (and usually settled) offline on an edge device.
   * Idempotent by (deviceId, clientId); reuses the KOT + station + inventory path so
   * offline sales deplete stock and reach the KDS once synced.
   */
  async applySyncedOrder(params: {
    tenantId: string;
    outletId: string;
    deviceId: string;
    order: SyncedOrderInput;
  }): Promise<{ serverId: string; billNumber: string | null; status: "applied" | "duplicate" }> {
    const { tenantId, outletId, deviceId, order } = params;
    const actor = { tenantId, id: null };
    const settled = order.status === "SETTLED";
    // Idempotency is enforced by the @@unique([deviceId, clientId]) constraint, not
    // a pre-check read: we attempt the insert and treat a unique violation as "this
    // order already synced". A pre-check findFirst has a window where two concurrent
    // deliveries of the same order both see nothing and both insert; letting the DB
    // arbitrate means the loser rolls back cleanly (including its bill-number
    // increment) and is reported as a duplicate.
    let orderId: string;
    try {
      orderId = await this.prisma.$transaction(async (tx) => {
      // The device's number is a provisional reference only. On sync, a settled
      // order is assigned the authoritative GST bill number from the single
      // outlet counter — the same series online settlements draw from — so the
      // outlet has one gapless invoice sequence regardless of where a sale began.
      let billNumber: string | null = null;
      if (settled) {
        const outlet = await tx.outlet.update({
          where: { id: outletId },
          data: { nextBillNumber: { increment: 1 } },
        });
        billNumber = `B-${outlet.nextBillNumber - 1}`;
      }
      const created = await tx.order.create({
        data: {
          tenantId,
          outletId,
          orderType: order.orderType,
          tableId: order.orderType === "DINE_IN" ? (order.tableId ?? null) : null,
          customerName: order.customerName ?? null,
          customerPhone: order.customerPhone ?? null,
          deviceId,
          clientId: order.clientId,
          offlineRef: order.offlineRef ?? null,
          status: order.status,
          billNumber,
        },
      });
      await this.punchItems(tx, actor, created.id, outletId, order.items);
      await this.recomputeTotals(tx, created.id, new Prisma.Decimal(order.discountAmount ?? 0));
      if (settled && order.payments.length) {
        await tx.orderPayment.createMany({
          data: order.payments.map((p) => ({ orderId: created.id, mode: p.mode, amount: p.amount })),
        });
      }
      await tx.auditLog.create({
        data: {
          tenantId,
          action: "ORDER_SYNCED",
          entity: "order",
          entityId: created.id,
          data: { deviceId, clientId: order.clientId, status: order.status, offlineRef: order.offlineRef, billNumber },
        },
      });
      return created.id;
      });
    } catch (e) {
      // Lost the idempotency race, or a re-delivery of an already-synced order: the
      // (deviceId, clientId) row already exists. Report it as a duplicate instead of
      // erroring, so the device stops retrying and clears it from the outbox.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const existing = await this.prisma.order.findFirst({ where: { deviceId, clientId: order.clientId } });
        if (existing) return { serverId: existing.id, billNumber: existing.billNumber, status: "duplicate" };
      }
      throw e;
    }
    this.realtime.notifyOutlet(outletId);
    const saved = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    return { serverId: orderId, billNumber: saved.billNumber, status: "applied" };
  }

  async addItems(user: AuthUser, orderId: string, input: AddItemsInput): Promise<OrderDto> {
    const order = await this.requireOrder(user, orderId);
    if (order.status !== "OPEN") throw new BadRequestException("Order is not open");
    await this.prisma.$transaction(async (tx) => {
      await this.punchItems(tx, user, order.id, order.outletId, input.items, input.combos);
      await this.recomputeTotals(tx, order.id);
    });
    this.realtime.notifyOutlet(order.outletId);
    return this.getOne(user, orderId);
  }

  async settle(user: AuthUser, orderId: string, input: SettleOrderInput): Promise<OrderDto> {
    const order = await this.requireOrder(user, orderId);
    if (order.status !== "OPEN") throw new BadRequestException("Order is not open");

    const outletRow = await this.prisma.outlet.findUniqueOrThrow({ where: { id: order.outletId } });
    const subtotal = Number(order.subtotal);
    const phone = (input.customerPhone ?? order.customerPhone ?? "").trim();
    const name = input.customerName ?? order.customerName ?? null;

    // Coupon discount (validated with the shared rule engine).
    let coupon: { id: string; code: string } | null = null;
    let couponDiscount = 0;
    if (input.couponCode) {
      const c = await this.prisma.coupon.findFirst({
        where: { outletId: order.outletId, code: input.couponCode.toUpperCase() },
      });
      const evalResult = evaluateCoupon(
        c
          ? {
              type: c.type as "PERCENT" | "FLAT",
              value: Number(c.value),
              minOrder: Number(c.minOrder),
              maxDiscount: c.maxDiscount ? Number(c.maxDiscount) : null,
              validFrom: c.validFrom?.toISOString() ?? null,
              validTo: c.validTo?.toISOString() ?? null,
              usageLimit: c.usageLimit,
              usedCount: c.usedCount,
              isActive: c.isActive,
            }
          : null,
        subtotal,
        new Date().toISOString(),
      );
      if (!evalResult.valid) throw new BadRequestException(evalResult.message);
      coupon = { id: c!.id, code: c!.code };
      couponDiscount = evalResult.discount;
    }

    // Loyalty redemption. The authoritative balance check + decrement runs
    // atomically inside the settle transaction (a conditional update below), so
    // concurrent settlements can never over-redeem the same balance. Here we only
    // need the phone (redemption requires a customer) and the discount value; a
    // stale pre-transaction read would be a time-of-check/time-of-use hole.
    const redeemPoints = input.redeemPoints ?? 0;
    let redeemDiscount = 0;
    if (redeemPoints > 0) {
      if (!phone) throw new BadRequestException("A customer phone is required to redeem points");
      redeemDiscount = redeemPoints * Number(outletRow.loyaltyPointValue);
    }

    const totalDiscount = Math.min((input.discountAmount ?? 0) + couponDiscount + redeemDiscount, subtotal);

    let earned = 0;
    await this.prisma.$transaction(async (tx) => {
      // Points redemption is OTP-gated: verify + consume the code atomically here,
      // so an invalid/expired OTP rolls back the whole settlement.
      if (redeemPoints > 0) {
        await this.loyaltyOtp.verifyAndConsume(tx, order.outletId, phone, input.redeemOtp);
      }
      const totals = await this.recomputeTotals(tx, order.id, new Prisma.Decimal(totalDiscount));
      const total = Number(totals.total);
      const paid = input.payments.reduce((s, p) => s + p.amount, 0);
      if (Math.abs(paid - total) > 0.01) {
        throw new BadRequestException(`Payments (${paid.toFixed(2)}) must equal order total (${total.toFixed(2)})`);
      }
      const outlet = await tx.outlet.update({
        where: { id: order.outletId },
        data: { nextBillNumber: { increment: 1 } },
      });
      const billNumber = `B-${outlet.nextBillNumber - 1}`;
      await tx.orderPayment.createMany({
        data: input.payments.map((p) => ({ orderId: order.id, mode: p.mode, amount: p.amount })),
      });

      // Record the cash portion into the open drawer, if one is open.
      const cashTaken = input.payments.filter((p) => p.mode === "CASH").reduce((s, p) => s + p.amount, 0);
      if (cashTaken > 0) {
        const session = await tx.cashSession.findFirst({ where: { outletId: order.outletId, status: "OPEN" } });
        if (session) {
          await tx.cashMovement.create({
            data: { sessionId: session.id, type: "SALE", amount: cashTaken, orderId: order.id, note: billNumber },
          });
        }
      }

      // Redeem atomically, BEFORE earning: a conditional decrement that only
      // matches while the customer still holds enough points. The row lock makes a
      // concurrent second settlement re-evaluate the (already decremented) balance,
      // so the same points can never be spent twice. Zero rows updated means the
      // balance is insufficient or the customer does not exist — throwing rolls the
      // whole settlement back.
      if (redeemPoints > 0) {
        const redeemed = await tx.customer.updateMany({
          where: { outletId: order.outletId, phone, loyaltyPoints: { gte: redeemPoints } },
          data: { loyaltyPoints: { decrement: redeemPoints } },
        });
        if (redeemed.count === 0) throw new BadRequestException("Customer does not have enough points to redeem");
      }

      // Customer + loyalty: earn on the final total, keep a ledger. Any redemption
      // was already applied above, so earning is a plain increment.
      let customerId: string | null = null;
      if (phone) {
        earned = Math.round(total * Number(outletRow.loyaltyEarnRate));
        const customer = await tx.customer.upsert({
          where: { outletId_phone: { outletId: order.outletId, phone } },
          create: {
            tenantId: user.tenantId,
            outletId: order.outletId,
            phone,
            name,
            loyaltyPoints: earned,
            totalOrders: 1,
            totalSpent: total,
            lastVisitAt: new Date(),
          },
          update: {
            name: name ?? undefined,
            loyaltyPoints: { increment: earned },
            totalOrders: { increment: 1 },
            totalSpent: { increment: total },
            lastVisitAt: new Date(),
          },
        });
        customerId = customer.id;
        if (earned > 0)
          await tx.loyaltyTransaction.create({
            data: { customerId, type: "EARN", points: earned, orderId: order.id },
          });
        if (redeemPoints > 0)
          await tx.loyaltyTransaction.create({
            data: { customerId, type: "REDEEM", points: -redeemPoints, orderId: order.id, note: "Redeemed at billing" },
          });
      }

      if (coupon) await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } });

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "SETTLED",
          billNumber,
          customerId,
          customerName: name ?? undefined,
          customerPhone: phone || undefined,
          couponCode: coupon?.code ?? null,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: "ORDER_SETTLED",
          entity: "order",
          entityId: order.id,
          data: {
            billNumber,
            total,
            payments: input.payments,
            couponCode: coupon?.code,
            couponDiscount,
            pointsEarned: earned,
            pointsRedeemed: redeemPoints,
          },
        },
      });
    });
    return this.getOne(user, orderId);
  }

  async cancel(user: AuthUser, orderId: string): Promise<OrderDto> {
    const order = await this.requireOrder(user, orderId);
    if (order.status !== "OPEN") throw new BadRequestException("Order is not open");
    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: "CANCELLED", version: { increment: 1 } },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: "ORDER_CANCELLED",
        entity: "order",
        entityId: order.id,
      },
    });
    this.realtime.notifyOutlet(order.outletId);
    return this.getOne(user, orderId);
  }

  async listOpen(user: AuthUser, outletId: string): Promise<OrderDto[]> {
    this.assertOutlet(user, outletId);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "OPEN" },
      include: orderInclude,
      orderBy: { createdAt: "asc" },
    });
    return orders.map((o) => this.toDto(o));
  }

  async getOne(user: AuthUser, orderId: string): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderInclude,
    });
    if (!order || order.tenantId !== user.tenantId) throw new NotFoundException("Order not found");
    this.assertOutlet(user, order.outletId);
    return this.toDto(order);
  }

  private async requireOrder(user: AuthUser, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.tenantId !== user.tenantId) throw new NotFoundException("Order not found");
    this.assertOutlet(user, order.outletId);
    return order;
  }

  /** Creates order items + a new KOT for them, snapshotting names and prices. */
  private async punchItems(
    tx: Prisma.TransactionClient,
    actor: { tenantId: string; id: string | null },
    orderId: string,
    outletId: string,
    inputs: OrderItemInput[],
    combos: ComboOrderInput[] = [],
  ) {
    const itemIds = [...new Set(inputs.map((i) => i.itemId))];
    const items = await tx.item.findMany({
      where: { id: { in: itemIds }, outletId, deletedAt: null },
      include: {
        variations: true,
        addonGroups: { include: { group: { include: { addons: true } } } },
        category: { select: { stationId: true } },
        recipe: true,
      },
    });
    const itemMap = new Map(items.map((i) => [i.id, i]));

    const outlet = await tx.outlet.update({
      where: { id: outletId },
      data: { nextKotNumber: { increment: 1 } },
    });
    const kot = await tx.kot.create({
      data: {
        tenantId: actor.tenantId,
        outletId,
        orderId,
        kotNumber: outlet.nextKotNumber - 1,
      },
    });

    // Accumulate raw-material consumption across this KOT's items (recipe × qty).
    const consumption = new Map<string, number>();

    for (const input of inputs) {
      const item = itemMap.get(input.itemId);
      if (!item) throw new BadRequestException(`Item not found: ${input.itemId}`);
      if (!item.inStock) throw new BadRequestException(`${item.name} is out of stock`);

      let unitPrice = Number(item.price);
      let variationName: string | null = null;
      if (input.variationId) {
        const variation = item.variations.find((v) => v.id === input.variationId);
        if (!variation) throw new BadRequestException(`Invalid variation for ${item.name}`);
        unitPrice = Number(variation.price);
        variationName = variation.name;
      }

      const allAddons = item.addonGroups.flatMap((ag) => ag.group.addons);
      const addons = (input.addonIds ?? []).map((id) => {
        const addon = allAddons.find((a) => a.id === id);
        if (!addon) throw new BadRequestException(`Invalid addon for ${item.name}`);
        return addon;
      });
      unitPrice += addons.reduce((s, a) => s + Number(a.price), 0);

      await tx.orderItem.create({
        data: {
          orderId,
          itemId: item.id,
          itemName: item.name,
          variationId: input.variationId ?? null,
          variationName,
          quantity: input.quantity,
          unitPrice,
          lineTotal: fromPaise(lineTotalPaise(unitPrice, input.quantity)),
          taxRate: item.taxRate,
          note: input.note ?? null,
          kotId: kot.id,
          stationId: item.category.stationId,
          addons: {
            create: addons.map((a) => ({ addonId: a.id, name: a.name, price: a.price })),
          },
        },
      });

      for (const line of item.recipe) {
        const need = Number(line.quantity) * input.quantity;
        consumption.set(line.rawMaterialId, (consumption.get(line.rawMaterialId) ?? 0) + need);
      }
    }

    // Explode each combo into a priced parent line (no KOT) + zero-priced component
    // lines that route to the kitchen and deplete their own recipes.
    for (const comboInput of combos) {
      const combo = await tx.combo.findFirst({
        where: { id: comboInput.comboId, outletId, deletedAt: null },
        include: { slots: { orderBy: { sortOrder: "asc" }, include: { options: true } } },
      });
      if (!combo) throw new BadRequestException(`Combo not found: ${comboInput.comboId}`);
      if (!combo.inStock) throw new BadRequestException(`${combo.name} is unavailable`);

      // Resolve one chosen item per slot (explicit selection, else the slot default).
      const chosen: { itemId: string; priceDelta: number }[] = [];
      for (const slot of combo.slots) {
        const sel = comboInput.selections.find((s) => s.slotId === slot.id);
        let option = sel ? slot.options.find((o) => o.itemId === sel.itemId) : undefined;
        if (sel && !option) throw new BadRequestException(`Invalid choice for ${slot.name}`);
        if (!option) option = slot.options.find((o) => o.isDefault) ?? slot.options[0];
        if (!option) throw new BadRequestException(`${combo.name}: ${slot.name} has no options`);
        chosen.push({ itemId: option.itemId, priceDelta: Number(option.priceDelta) });
      }

      const comboGroupId = randomUUID();
      const comboUnit = Number(combo.price) + chosen.reduce((s, c) => s + c.priceDelta, 0);

      await tx.orderItem.create({
        data: {
          orderId,
          itemId: combo.id,
          itemName: combo.name,
          quantity: comboInput.quantity,
          unitPrice: comboUnit,
          lineTotal: fromPaise(lineTotalPaise(comboUnit, comboInput.quantity)),
          taxRate: combo.taxRate,
          note: comboInput.note ?? null,
          comboId: combo.id,
          comboGroupId,
          isComboComponent: false,
        },
      });

      const chosenItems = await tx.item.findMany({
        where: { id: { in: chosen.map((c) => c.itemId) } },
        include: { category: { select: { stationId: true } }, recipe: true },
      });
      const chosenMap = new Map(chosenItems.map((i) => [i.id, i]));
      for (const c of chosen) {
        const item = chosenMap.get(c.itemId);
        if (!item) throw new BadRequestException("A combo component is unavailable");
        if (!item.inStock) throw new BadRequestException(`${item.name} is out of stock`);
        await tx.orderItem.create({
          data: {
            orderId,
            itemId: item.id,
            itemName: item.name,
            quantity: comboInput.quantity,
            unitPrice: 0,
            lineTotal: 0,
            taxRate: item.taxRate,
            kotId: kot.id,
            stationId: item.category.stationId,
            comboId: combo.id,
            comboGroupId,
            isComboComponent: true,
          },
        });
        for (const line of item.recipe) {
          const need = Number(line.quantity) * comboInput.quantity;
          consumption.set(line.rawMaterialId, (consumption.get(line.rawMaterialId) ?? 0) + need);
        }
      }
    }

    // Deplete stock and write the consumption ledger for items that have a recipe.
    for (const [rawMaterialId, qty] of consumption) {
      await tx.rawMaterial.update({
        where: { id: rawMaterialId },
        data: { stockQty: { decrement: qty } },
      });
      await tx.stockMovement.create({
        data: {
          tenantId: actor.tenantId,
          outletId,
          rawMaterialId,
          type: "CONSUMPTION",
          quantity: -qty,
          refType: "kot",
          refId: kot.id,
          createdById: actor.id,
        },
      });
    }
  }

  /** Recomputes subtotal/tax/total. Discount is applied before tax, proportionally. */
  private async recomputeTotals(
    tx: Prisma.TransactionClient,
    orderId: string,
    discount?: Prisma.Decimal,
  ) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    // Compute in integer paise via the shared formula the edge device also uses,
    // so an order's totals are identical whether billed online or offline.
    const totals = computeOrderTotals(
      items.map((i) => ({ lineTotalPaise: toPaise(Number(i.lineTotal)), taxRatePercent: Number(i.taxRate) })),
      Number(discount ?? 0),
    );
    return tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        version: { increment: 1 },
      },
    });
  }

  private toDto(order: OrderWithRelations): OrderDto {
    const tax = Number(order.taxAmount);
    return {
      id: order.id,
      billNumber: order.billNumber,
      orderType: order.orderType as OrderDto["orderType"],
      status: order.status as OrderDto["status"],
      tableId: order.tableId,
      tableName: order.table?.name ?? null,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      subtotal: Number(order.subtotal),
      discountAmount: Number(order.discountAmount),
      taxAmount: tax,
      cgst: Math.round((tax / 2) * 100) / 100,
      sgst: Math.round((tax / 2) * 100) / 100,
      total: Number(order.total),
      items: order.items.map((i) => ({
        id: i.id,
        itemName: i.itemName,
        variationName: i.variationName,
        addonNames: i.addons.map((a) => a.name),
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
        lineTotal: Number(i.lineTotal),
        note: i.note,
        kotNumber: i.kot?.kotNumber ?? null,
        comboName: i.comboId && !i.isComboComponent ? i.itemName : null,
        comboGroupId: i.comboGroupId,
        isComboComponent: i.isComboComponent,
      })),
      kots: order.kots.map((k) => ({
        id: k.id,
        kotNumber: k.kotNumber,
        status: k.status,
        createdAt: k.createdAt.toISOString(),
        items: k.items.map((i) => ({
          itemName: i.itemName,
          variationName: i.variationName,
          quantity: i.quantity,
          note: i.note,
        })),
      })),
      payments: order.payments.map((p) => ({
        mode: p.mode as OrderDto["payments"][number]["mode"],
        amount: Number(p.amount),
      })),
      createdAt: order.createdAt.toISOString(),
    };
  }
}
