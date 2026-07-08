import { z } from "zod";

export const OrderType = z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY"]);
export type OrderType = z.infer<typeof OrderType>;

export const OrderStatus = z.enum(["OPEN", "BILLED", "SETTLED", "CANCELLED"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const PaymentMode = z.enum(["CASH", "CARD", "UPI", "WALLET", "OTHER"]);
export type PaymentMode = z.infer<typeof PaymentMode>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const OrderItemInputSchema = z.object({
  itemId: z.string().min(1),
  variationId: z.string().optional(),
  addonIds: z.array(z.string()).default([]),
  quantity: z.number().int().positive(),
  note: z.string().max(200).optional(),
});
export type OrderItemInput = z.infer<typeof OrderItemInputSchema>;

// A combo added to an order: one chosen item per "choose-one" slot.
export const ComboSelectionSchema = z.object({
  slotId: z.string().min(1),
  itemId: z.string().min(1),
});
export const ComboOrderInputSchema = z.object({
  comboId: z.string().min(1),
  quantity: z.number().int().positive(),
  note: z.string().max(200).optional(),
  selections: z.array(ComboSelectionSchema).default([]),
});
export type ComboOrderInput = z.infer<typeof ComboOrderInputSchema>;

export const CreateOrderSchema = z
  .object({
    outletId: z.string().min(1),
    orderType: OrderType,
    tableId: z.string().optional(),
    customerName: z.string().optional(),
    customerPhone: z.string().optional(),
    items: z.array(OrderItemInputSchema).default([]),
    combos: z.array(ComboOrderInputSchema).default([]),
  })
  .refine((v) => v.items.length + v.combos.length > 0, {
    message: "An order needs at least one item or combo",
  });
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

export const AddItemsSchema = z
  .object({
    items: z.array(OrderItemInputSchema).default([]),
    combos: z.array(ComboOrderInputSchema).default([]),
  })
  .refine((v) => v.items.length + v.combos.length > 0, {
    message: "Add at least one item or combo",
  });
export type AddItemsInput = z.infer<typeof AddItemsSchema>;

// ---------- Menu management ----------

const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM (24h)");

export const CreateCategorySchema = z.object({
  name: z.string().min(1).max(60),
  sortOrder: z.number().int().optional(),
  stationId: z.string().nullable().optional(),
});
export type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = CreateCategorySchema.partial();
export type UpdateCategoryInput = z.infer<typeof UpdateCategorySchema>;

export const VariationInputSchema = z.object({
  name: z.string().min(1).max(60),
  price: z.number().nonnegative(),
});

export const ItemChannelConfigSchema = z.object({
  channelId: z.string().min(1),
  price: z.number().nonnegative().nullable().optional(),
  isListed: z.boolean().default(true),
  externalId: z.string().max(120).nullable().optional(),
});

export const CreateItemSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1).max(120),
  shortCode: z.string().max(12).nullable().optional(),
  price: z.number().nonnegative(),
  isVeg: z.boolean().default(true),
  taxRate: z.number().min(0).max(28).default(5),
  sortOrder: z.number().int().optional(),
  availableStart: HHMM.nullable().optional(),
  availableEnd: HHMM.nullable().optional(),
  variations: z.array(VariationInputSchema).default([]),
  addonGroupIds: z.array(z.string()).default([]),
  channels: z.array(ItemChannelConfigSchema).default([]),
});
export type CreateItemInput = z.infer<typeof CreateItemSchema>;

export const UpdateItemSchema = CreateItemSchema.partial();
export type UpdateItemInput = z.infer<typeof UpdateItemSchema>;

export const AddonInputSchema = z.object({
  name: z.string().min(1).max(60),
  price: z.number().nonnegative(),
});

export const AddonGroupSchema = z.object({
  name: z.string().min(1).max(60),
  minSelect: z.number().int().min(0).default(0),
  maxSelect: z.number().int().min(1).default(1),
  addons: z.array(AddonInputSchema).min(1),
});
export type AddonGroupInput = z.infer<typeof AddonGroupSchema>;

export const ChannelSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(["DIRECT", "AGGREGATOR"]).default("DIRECT"),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().optional(),
});
export type ChannelInput = z.infer<typeof ChannelSchema>;

// ---------- Inventory ----------

export const UnitEnum = z.enum(["KG", "G", "L", "ML", "PCS"]);

export const CreateMaterialSchema = z.object({
  name: z.string().min(1).max(80),
  unit: UnitEnum,
  stockQty: z.number().min(0).default(0),
  reorderLevel: z.number().min(0).default(0),
  costPerUnit: z.number().min(0).default(0),
});
export type CreateMaterialInput = z.infer<typeof CreateMaterialSchema>;

export const UpdateMaterialSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  unit: UnitEnum.optional(),
  reorderLevel: z.number().min(0).optional(),
  // stock changes go through receive/wastage/adjust, not a direct edit
});
export type UpdateMaterialInput = z.infer<typeof UpdateMaterialSchema>;

export const ReceiveStockSchema = z.object({
  quantity: z.number().positive(),
  unitCost: z.number().min(0),
  vendorId: z.string().nullable().optional(),
});
export type ReceiveStockInput = z.infer<typeof ReceiveStockSchema>;

export const WastageSchema = z.object({
  quantity: z.number().positive(),
  reason: z.string().max(120).optional(),
});
export type WastageInput = z.infer<typeof WastageSchema>;

export const VendorSchema = z.object({
  name: z.string().min(1).max(80),
  phone: z.string().max(20).nullable().optional(),
});
export type VendorInput = z.infer<typeof VendorSchema>;

export const SetRecipeSchema = z.object({
  ingredients: z
    .array(
      z.object({
        rawMaterialId: z.string().min(1),
        quantity: z.number().positive(),
      }),
    )
    .default([]),
});
export type SetRecipeInput = z.infer<typeof SetRecipeSchema>;

// ---------- Aggregator connector ----------

export const AggregatorPlatformEnum = z.enum(["ZOMATO", "SWIGGY", "ONDC", "URBANPIPER"]);
export const AggregatorStatusEnum = z.enum([
  "RECEIVED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "PICKED_UP",
  "DELIVERED",
  "REJECTED",
  "CANCELLED",
]);

/** Canonical order the connector forwards to the main API after normalising. */
export const ConnectorIngestSchema = z.object({
  platform: AggregatorPlatformEnum,
  externalOrderId: z.string().min(1),
  outletId: z.string().min(1),
  items: z
    .array(
      z.object({
        externalItemId: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  customerName: z.string().nullable().optional(),
  customerPhoneMasked: z.string().nullable().optional(),
  orderValue: z.number().min(0),
  rawPayload: z.unknown().optional(),
});
export type ConnectorIngestInput = z.infer<typeof ConnectorIngestSchema>;

export const AggregatorStatusUpdateSchema = z.object({
  status: AggregatorStatusEnum,
});
export type AggregatorStatusUpdateInput = z.infer<typeof AggregatorStatusUpdateSchema>;

// ---------- CRM / loyalty / marketing ----------

export const CouponTypeEnum = z.enum(["PERCENT", "FLAT"]);

export const CouponSchema = z.object({
  code: z.string().min(2).max(40).transform((s) => s.toUpperCase()),
  type: CouponTypeEnum,
  value: z.number().positive(),
  minOrder: z.number().min(0).default(0),
  maxDiscount: z.number().positive().nullable().optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validTo: z.string().datetime().nullable().optional(),
  usageLimit: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CouponInput = z.infer<typeof CouponSchema>;

export const CampaignChannelEnum = z.enum(["SMS", "WHATSAPP", "EMAIL"]);
export const CustomerSegmentEnum = z.enum(["ALL", "NEW", "REGULAR", "VIP", "LAPSED"]);

export const CampaignSchema = z.object({
  name: z.string().min(1).max(80),
  channel: CampaignChannelEnum,
  segment: CustomerSegmentEnum,
  message: z.string().min(1).max(480),
});
export type CampaignInput = z.infer<typeof CampaignSchema>;

export const LoyaltyAdjustSchema = z.object({
  points: z.number().int().refine((n) => n !== 0, "Points must be non-zero"),
  note: z.string().max(120).optional(),
});
export type LoyaltyAdjustInput = z.infer<typeof LoyaltyAdjustSchema>;

export const FeedbackSubmitSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(480).optional(),
  orderId: z.string().optional(),
  phone: z.string().max(20).optional(),
});
export type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitSchema>;

// ---------- Cash management + payments ----------

export const OpenDrawerSchema = z.object({
  openingFloat: z.number().min(0),
});
export type OpenDrawerInput = z.infer<typeof OpenDrawerSchema>;

export const CloseDrawerSchema = z.object({
  countedCash: z.number().min(0),
});
export type CloseDrawerInput = z.infer<typeof CloseDrawerSchema>;

export const CashMovementSchema = z.object({
  type: z.enum(["PAY_IN", "PAY_OUT", "EXPENSE"]),
  amount: z.number().positive(),
  category: z.string().max(40).optional(),
  note: z.string().max(120).optional(),
});
export type CashMovementInput = z.infer<typeof CashMovementSchema>;

export const RefundSchema = z.object({
  amount: z.number().positive(),
  mode: PaymentMode,
  reason: z.string().max(120).optional(),
});
export type RefundInput = z.infer<typeof RefundSchema>;

// ---------- Offline sync ----------

export const SyncedOrderSchema = z.object({
  clientId: z.string().min(1),
  orderType: OrderType,
  tableId: z.string().nullable().optional(),
  customerName: z.string().nullable().optional(),
  customerPhone: z.string().nullable().optional(),
  items: z.array(OrderItemInputSchema).min(1),
  payments: z
    .array(z.object({ mode: PaymentMode, amount: z.number().positive() }))
    .default([]),
  status: z.enum(["OPEN", "SETTLED", "CANCELLED"]),
  // Provisional device reference. The authoritative GST bill/invoice number is
  // assigned by the server from the single outlet counter at sync time.
  offlineRef: z.string().max(40).nullable().optional(),
  discountAmount: z.number().min(0).optional(),
  clientUpdatedAt: z.string(), // ISO; drives last-write-wins
  clientVersion: z.number().int().default(1),
});
export type SyncedOrderInput = z.infer<typeof SyncedOrderSchema>;

export const SyncPushSchema = z.object({
  outletId: z.string().min(1),
  deviceId: z.string().min(1),
  orders: z.array(SyncedOrderSchema).max(200),
});
export type SyncPushInput = z.infer<typeof SyncPushSchema>;

// ---------- Central kitchen ----------

export const CreateIndentSchema = z.object({
  toOutletId: z.string().min(1), // the central kitchen
  note: z.string().max(160).optional(),
  items: z
    .array(
      z.object({
        rawMaterialId: z.string().min(1),
        requestedQty: z.number().positive(),
      }),
    )
    .min(1),
});
export type CreateIndentInput = z.infer<typeof CreateIndentSchema>;

export const GenerateEwayBillSchema = z.object({
  distanceKm: z.number().int().min(0).max(4000).optional(),
});
export type GenerateEwayBillInput = z.infer<typeof GenerateEwayBillSchema>;

export const PrepStatusEnum = z.enum(["PENDING", "PREPARING", "READY"]);

export const AdvanceTicketSchema = z.object({
  stationId: z.string().nullable(),
  toStatus: PrepStatusEnum,
});
export type AdvanceTicketInput = z.infer<typeof AdvanceTicketSchema>;

export const SettleOrderSchema = z.object({
  payments: z
    .array(
      z.object({
        mode: PaymentMode,
        amount: z.number().positive(),
      }),
    )
    .min(1),
  discountAmount: z.number().min(0).optional(),
  couponCode: z.string().max(40).optional(),
  redeemPoints: z.number().int().min(0).optional(),
  redeemOtp: z.string().max(8).optional(), // required when redeeming points
  customerPhone: z.string().max(20).optional(),
  customerName: z.string().max(80).optional(),
});
export type SettleOrderInput = z.infer<typeof SettleOrderSchema>;

// Request a redemption OTP be sent to a customer's phone.
export const RequestOtpSchema = z.object({
  phone: z.string().min(6).max(20),
});
export type RequestOtpInput = z.infer<typeof RequestOtpSchema>;

// ---------- Scan & Order (first-party online ordering) ----------

// A diner submits a cart against a table/outlet public token. No auth; staff
// validates before it becomes a real order + KOT.
export const SubmitOrderRequestSchema = z
  .object({
    items: z.array(OrderItemInputSchema).default([]),
    combos: z.array(ComboOrderInputSchema).default([]),
    customerName: z.string().max(80).optional(),
    customerPhone: z.string().max(20).optional(),
    note: z.string().max(200).optional(),
  })
  .refine((v) => v.items.length + v.combos.length > 0, {
    message: "Add at least one item or combo",
  });
export type SubmitOrderRequestInput = z.infer<typeof SubmitOrderRequestSchema>;

// ---------- Combo administration ----------

export const ComboSlotOptionInputSchema = z.object({
  itemId: z.string().min(1),
  priceDelta: z.number().default(0),
  isDefault: z.boolean().default(false),
});
export const ComboSlotInputSchema = z.object({
  name: z.string().min(1).max(60),
  options: z.array(ComboSlotOptionInputSchema).min(1),
});
export const CreateComboSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1).max(80),
  price: z.number().nonnegative(),
  isVeg: z.boolean().default(true),
  taxRate: z.number().min(0).max(28).default(5),
  slots: z.array(ComboSlotInputSchema).min(1),
});
export type CreateComboInput = z.infer<typeof CreateComboSchema>;

// Full replace of a combo (metadata + slots/options rebuilt).
export const UpdateComboSchema = CreateComboSchema.partial({ categoryId: true }).extend({
  slots: z.array(ComboSlotInputSchema).min(1).optional(),
});
export type UpdateComboInput = z.infer<typeof UpdateComboSchema>;

export const ComboStockSchema = z.object({ inStock: z.boolean() });

// ---------- Multi-stage recipes (semi-finished goods) ----------

// Define the prep recipe of a semi-finished material: inputs per 1 output unit.
// An empty ingredient list clears the recipe and un-flags the material.
export const SetPrepRecipeSchema = z.object({
  ingredients: z
    .array(
      z.object({
        inputMaterialId: z.string().min(1),
        quantity: z.number().positive(),
      }),
    )
    .default([]),
});
export type SetPrepRecipeInput = z.infer<typeof SetPrepRecipeSchema>;

// Produce a batch of the semi-finished good (consumes inputs, yields output).
export const ProduceBatchSchema = z.object({
  quantity: z.number().positive(),
});
export type ProduceBatchInput = z.infer<typeof ProduceBatchSchema>;

// ---------- Custom report builder ----------

export const ReportDimensionEnum = z.enum(["item", "category", "orderType", "paymentMode", "hour", "day"]);
export const ReportMetricEnum = z.enum(["revenue", "orders", "quantity"]);
export const CustomReportSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  dimension: ReportDimensionEnum,
  metric: ReportMetricEnum,
});
export type CustomReportInput = z.infer<typeof CustomReportSchema>;

// ---------- Device fleet management ----------

export const DeviceTypeEnum = z.enum(["POS", "KDS", "PRINTER", "KIOSK", "DISPLAY"]);
export const CreateDeviceSchema = z.object({
  name: z.string().min(1).max(60),
  type: DeviceTypeEnum,
});
export type CreateDeviceInput = z.infer<typeof CreateDeviceSchema>;

export const UpdateDeviceSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  type: DeviceTypeEnum.optional(),
  isActive: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});
export type UpdateDeviceInput = z.infer<typeof UpdateDeviceSchema>;

// ---------- Brand theme ----------

import { THEMES } from "./theme";
export const UpdateBrandThemeSchema = z.object({
  themeId: z.enum(THEMES.map((t) => t.id) as [string, ...string[]]),
});
export type UpdateBrandThemeInput = z.infer<typeof UpdateBrandThemeSchema>;
