import type { OrderStatus, OrderType, PaymentMode } from "./schemas";

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  roleName: string;
  permissions: string[];
  outletIds: string[];
  isPlatformAdmin: boolean;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

export interface MenuAddonDto {
  id: string;
  name: string;
  price: number;
}

export interface MenuAddonGroupDto {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  addons: MenuAddonDto[];
}

export interface MenuVariationDto {
  id: string;
  name: string;
  price: number;
}

export interface MenuItemDto {
  id: string;
  name: string;
  shortCode: string | null;
  price: number;
  isVeg: boolean;
  inStock: boolean;
  taxRate: number;
  variations: MenuVariationDto[];
  addonGroups: MenuAddonGroupDto[];
}

export interface ComboSlotOptionDto {
  id: string;
  itemId: string;
  name: string;
  priceDelta: number;
  isDefault: boolean;
  isVeg: boolean;
  inStock: boolean;
}

export interface ComboSlotDto {
  id: string;
  name: string;
  options: ComboSlotOptionDto[];
}

export interface ComboDto {
  id: string;
  categoryId: string;
  name: string;
  price: number;
  isVeg: boolean;
  inStock: boolean;
  taxRate: number;
  slots: ComboSlotDto[];
}

export interface MenuCategoryDto {
  id: string;
  name: string;
  sortOrder: number;
  items: MenuItemDto[];
  combos: ComboDto[];
}

export interface TableDto {
  id: string;
  name: string;
  seats: number;
  occupiedByOrderId: string | null;
}

export interface AreaDto {
  id: string;
  name: string;
  tables: TableDto[];
}

export interface OrderItemDto {
  id: string;
  itemName: string;
  variationName: string | null;
  addonNames: string[];
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  note: string | null;
  kotNumber: number | null;
  comboName: string | null; // set on a combo's parent line
  comboGroupId: string | null; // groups a combo's parent + component lines
  isComboComponent: boolean; // zero-priced kitchen line under a combo
}

export interface KotDto {
  id: string;
  kotNumber: number;
  status: string;
  createdAt: string;
  items: { itemName: string; variationName: string | null; quantity: number; note: string | null }[];
}

export interface OrderDto {
  id: string;
  billNumber: string | null;
  orderType: OrderType;
  status: OrderStatus;
  tableId: string | null;
  tableName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  cgst: number;
  sgst: number;
  total: number;
  items: OrderItemDto[];
  kots: KotDto[];
  payments: { mode: PaymentMode; amount: number }[];
  createdAt: string;
}

export interface OutletDto {
  id: string;
  name: string;
  brandName: string;
  brandId: string;
  themeId: string;
  address: string | null;
}

export type PrepStatus = "PENDING" | "PREPARING" | "READY";

export interface StationDto {
  id: string;
  name: string;
  prepMinutes: number;
  sortOrder: number;
}

export interface KdsTicketItemDto {
  id: string;
  itemId: string;
  name: string;
  variationName: string | null;
  addonNames: string[];
  quantity: number;
  note: string | null;
}

/** One station's slice of a KOT — the unit the kitchen bumps. */
export interface KdsTicketDto {
  key: string; // `${kotId}::${stationId}`
  kotId: string;
  kotNumber: number;
  orderId: string;
  orderType: OrderType;
  tableName: string | null;
  stationId: string | null;
  stationName: string;
  prepMinutes: number;
  status: PrepStatus;
  createdAt: string; // KOT creation time (drives ageing)
  preppedAt: string | null;
  items: KdsTicketItemDto[];
}

export interface KdsStockItemDto {
  itemId: string;
  name: string;
  inStock: boolean;
}

// ---------- Menu management (admin dashboard) ----------

export type ChannelKind = "DIRECT" | "AGGREGATOR";

export interface ChannelDto {
  id: string;
  name: string;
  kind: ChannelKind;
  isActive: boolean;
  sortOrder: number;
}

export interface AddonGroupAdminDto {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  addons: { id: string; name: string; price: number }[];
}

export interface ItemChannelConfigDto {
  channelId: string;
  price: number | null; // null = fall back to base price
  isListed: boolean;
  externalId: string | null; // aggregator item id
}

export interface AdminItemDto {
  id: string;
  categoryId: string;
  name: string;
  shortCode: string | null;
  price: number;
  isVeg: boolean;
  inStock: boolean;
  taxRate: number;
  sortOrder: number;
  availableStart: string | null;
  availableEnd: string | null;
  variations: { id: string; name: string; price: number }[];
  addonGroupIds: string[];
  channels: ItemChannelConfigDto[];
}

export interface AdminCategoryDto {
  id: string;
  name: string;
  sortOrder: number;
  stationId: string | null;
  items: AdminItemDto[];
}

export interface AdminMenuDto {
  categories: AdminCategoryDto[];
  addonGroups: AddonGroupAdminDto[];
  channels: ChannelDto[];
  stations: StationDto[];
  combos: ComboDto[];
}

// ---------- Inventory ----------

export type MaterialUnit = "KG" | "G" | "L" | "ML" | "PCS";

export interface RawMaterialDto {
  id: string;
  name: string;
  unit: MaterialUnit;
  stockQty: number;
  reorderLevel: number;
  costPerUnit: number;
  lowStock: boolean;
  isSemiFinished: boolean; // produced in-house from a prep recipe
}

// One input line of a semi-finished good's prep recipe.
export interface PrepIngredientDto {
  inputMaterialId: string;
  materialName: string;
  unit: MaterialUnit;
  quantity: number; // input qty per 1 unit of output
  costPerUnit: number;
  lineCost: number;
  stockQty: number; // current stock of the input (for feasibility hints)
}

// A semi-finished material's prep recipe + what one batch unit costs.
export interface PrepRecipeDto {
  materialId: string;
  materialName: string;
  unit: MaterialUnit;
  stockQty: number;
  isSemiFinished: boolean;
  ingredients: PrepIngredientDto[];
  unitCost: number; // cost to produce one unit of the output
}

export interface VendorDto {
  id: string;
  name: string;
  phone: string | null;
}

export interface RecipeIngredientDto {
  rawMaterialId: string;
  materialName: string;
  unit: MaterialUnit;
  quantity: number;
  costPerUnit: number;
  lineCost: number;
}

export interface ItemRecipeDto {
  itemId: string;
  itemName: string;
  price: number;
  ingredients: RecipeIngredientDto[];
  foodCost: number;
  marginPct: number | null; // null when price is 0
}

/** Compact per-item costing row for the recipes overview. */
export interface ItemCostDto {
  itemId: string;
  categoryName: string;
  name: string;
  price: number;
  foodCost: number;
  marginPct: number | null;
  ingredientCount: number;
}

export interface ConsumptionRowDto {
  rawMaterialId: string;
  name: string;
  unit: MaterialUnit;
  consumedQty: number;
  consumedCost: number;
}

export interface StockMovementDto {
  id: string;
  type: "RECEIPT" | "CONSUMPTION" | "WASTAGE" | "ADJUSTMENT";
  materialName: string;
  unit: MaterialUnit;
  quantity: number;
  unitCost: number | null;
  reason: string | null;
  createdAt: string;
}

// ---------- Aggregator connector ----------

export type AggregatorPlatform = "ZOMATO" | "SWIGGY" | "ONDC" | "URBANPIPER";
export type AggregatorStatus =
  | "RECEIVED"
  | "ACCEPTED"
  | "PREPARING"
  | "READY"
  | "PICKED_UP"
  | "DELIVERED"
  | "REJECTED"
  | "CANCELLED";

export interface AggregatorOrderDto {
  id: string;
  platform: AggregatorPlatform;
  externalOrderId: string;
  orderId: string | null;
  status: AggregatorStatus;
  customerName: string | null;
  orderValue: number;
  unmatchedItems: string[];
  itemSummary: string; // "2× Butter Chicken, 1× Garlic Naan"
  createdAt: string;
}

export interface ConnectorIngestResult {
  aggregatorOrderId: string;
  orderId: string | null;
  kotNumber: number | null;
  matched: number;
  unmatched: string[];
  duplicate: boolean;
}

export interface MenuPushRowDto {
  externalId: string;
  itemName: string;
  price: number; // channel price (override or base)
  inStock: boolean;
}

export interface ReconciliationRowDto {
  platform: AggregatorPlatform;
  orders: number;
  gross: number;
  delivered: number;
  rejected: number;
}

// ---------- CRM / loyalty / marketing ----------

export type CustomerSegment = "NEW" | "REGULAR" | "VIP" | "LAPSED";

export interface CustomerDto {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  loyaltyPoints: number;
  totalOrders: number;
  totalSpent: number;
  lastVisitAt: string | null;
  segment: CustomerSegment;
  createdAt: string;
}

export interface LoyaltyTxnDto {
  id: string;
  type: "EARN" | "REDEEM" | "TOPUP" | "ADJUST";
  points: number;
  note: string | null;
  createdAt: string;
}

export interface CustomerOrderDto {
  id: string;
  billNumber: string | null;
  orderType: OrderType;
  total: number;
  createdAt: string;
}

export interface CustomerDetailDto {
  customer: CustomerDto;
  transactions: LoyaltyTxnDto[];
  orders: CustomerOrderDto[];
}

export interface CustomerSummaryDto {
  total: number;
  segments: Record<CustomerSegment, number>;
  pointValue: number; // rupee value of 1 loyalty point
}

export interface CustomerLookupDto {
  found: boolean;
  id: string | null;
  name: string | null;
  loyaltyPoints: number;
  pointValue: number;
}

export interface CouponDto {
  id: string;
  code: string;
  type: "PERCENT" | "FLAT";
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  validFrom: string | null;
  validTo: string | null;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

export interface CouponPreviewDto {
  valid: boolean;
  discount: number;
  message: string;
}

export interface CampaignDto {
  id: string;
  name: string;
  channel: "SMS" | "WHATSAPP" | "EMAIL";
  segment: "ALL" | "NEW" | "REGULAR" | "VIP" | "LAPSED";
  message: string;
  sentCount: number;
  status: "DRAFT" | "SENT";
  createdAt: string;
}

export interface FeedbackDto {
  id: string;
  rating: number;
  comment: string | null;
  customerName: string | null;
  createdAt: string;
}

/** Loyalty/coupon breakdown returned on the order after settlement. */
export interface LoyaltyOnOrderDto {
  customerId: string | null;
  pointsEarned: number;
  pointsRedeemed: number;
  couponCode: string | null;
  couponDiscount: number;
}

// ---------- Reports ----------

export interface SalesPointDto {
  date: string; // YYYY-MM-DD
  sales: number;
  orders: number;
}

export interface ReportOverviewDto {
  from: string;
  to: string;
  grossSales: number; // sum of settled order totals
  netSales: number; // sales excluding tax
  orders: number;
  avgOrderValue: number;
  taxCollected: number;
  discountsGiven: number;
  newCustomers: number;
  series: SalesPointDto[];
}

export interface BreakdownRowDto {
  key: string;
  label: string;
  amount: number;
  count: number;
  share: number; // 0..1 of total amount
}

export interface ItemSalesRowDto {
  itemName: string;
  category: string;
  qty: number;
  revenue: number;
}

export interface TaxSummaryDto {
  taxableValue: number;
  cgst: number;
  sgst: number;
  totalTax: number;
}

export interface ReportBreakdownDto {
  payments: BreakdownRowDto[];
  orderTypes: BreakdownRowDto[];
  categories: BreakdownRowDto[];
  topItems: ItemSalesRowDto[];
  tax: TaxSummaryDto;
}

// ---------- Custom report builder ----------

export type ReportDimension = "item" | "category" | "orderType" | "paymentMode" | "hour" | "day";
export type ReportMetric = "revenue" | "orders" | "quantity";

export interface CustomReportRowDto {
  key: string;
  label: string;
  value: number;
  share: number; // 0..1 of the total
}

export interface CustomReportDto {
  from: string;
  to: string;
  dimension: ReportDimension;
  metric: ReportMetric;
  unit: "currency" | "count";
  rows: CustomReportRowDto[];
  total: number;
}

export interface DayEndReportDto {
  date: string;
  orders: number;
  cancelledOrders: number;
  gross: number;
  net: number;
  discounts: number;
  cgst: number;
  sgst: number;
  firstBill: string | null;
  lastBill: string | null;
  payments: BreakdownRowDto[];
  orderTypes: BreakdownRowDto[];
}

export interface FraudOrderDto {
  billNumber: string | null;
  orderType: OrderType;
  total: number;
  discountAmount: number;
  couponCode: string | null;
  status: OrderStatus;
  createdAt: string;
}

export interface FraudReportDto {
  cancelledCount: number;
  discountedCount: number;
  discountedValue: number;
  cancelled: FraudOrderDto[];
  discounted: FraudOrderDto[];
}

/** Owner cross-outlet snapshot. */
export interface OutletKpiDto {
  outletId: string;
  outletName: string;
  grossSales: number;
  orders: number;
  avgOrderValue: number;
}

// ---------- Cash management + payments ----------

export interface CashSessionDto {
  id: string;
  status: "OPEN" | "CLOSED";
  openingFloat: number;
  openedAt: string;
  closedAt: string | null;
  countedCash: number | null;
  cashSales: number;
  payIns: number;
  payOuts: number;
  expenses: number;
  refunds: number;
  expectedCash: number; // opening + sales + payIns − payOuts − expenses − cash refunds
  variance: number | null; // countedCash − expectedCash (once closed)
}

export interface CashMovementDto {
  id: string;
  type: "SALE" | "PAY_IN" | "PAY_OUT" | "EXPENSE" | "REFUND";
  amount: number;
  category: string | null;
  note: string | null;
  createdAt: string;
}

export interface ExpenseByCategoryDto {
  category: string;
  amount: number;
}

export interface CashSessionReportDto {
  session: CashSessionDto;
  movements: CashMovementDto[];
  expensesByCategory: ExpenseByCategoryDto[];
}

export interface UpiQrDto {
  upiString: string; // upi://pay?...
  amount: number;
  ref: string;
  payeeVpa: string;
}

export interface RefundDto {
  id: string;
  amount: number;
  mode: PaymentMode;
  reason: string | null;
  createdAt: string;
}

// ---------- GST e-invoicing ----------

export type InvoiceStatus = "PENDING" | "GENERATED" | "CANCELLED";

export interface HsnSummaryRowDto {
  hsn: string;
  taxable: number;
  rate: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface InvoiceDto {
  id: string;
  orderId: string;
  invoiceNumber: string;
  invoiceDate: string;
  customerName: string | null;
  sellerGstin: string | null;
  buyerGstin: string | null;
  placeOfSupply: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  hsnSummary: HsnSummaryRowDto[];
  irn: string | null;
  signedQr: string | null;
  ackNo: string | null;
  ackDate: string | null;
  status: InvoiceStatus;
}

/** Compact row for the invoices list. */
export interface InvoiceRowDto {
  orderId: string;
  invoiceNumber: string;
  invoiceDate: string;
  customerName: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  status: InvoiceStatus;
  hasIrn: boolean;
}

// ---------- Offline sync ----------

export type SyncApplyStatus = "applied" | "duplicate" | "conflict" | "error";

export interface SyncPushResultRowDto {
  clientId: string;
  serverId: string | null;
  billNumber: string | null;
  status: SyncApplyStatus;
  message?: string;
}

export interface SyncPushResultDto {
  results: SyncPushResultRowDto[];
  serverTime: string;
}

/** Reference data a device caches to operate offline. */
export interface SyncSnapshotDto {
  menu: MenuCategoryDto[];
  areas: AreaDto[];
  themeId: string;
  serverTime: string;
}

export interface SyncPulledOrderDto {
  id: string;
  deviceId: string | null;
  clientId: string | null;
  billNumber: string | null;
  status: OrderStatus;
  orderType: OrderType;
  total: number;
  updatedAt: string;
}

export interface SyncPullDto {
  orders: SyncPulledOrderDto[];
  cursor: string; // pass back as ?since= next time
}

// ---------- Central kitchen / commissary ----------

export type IndentStatus = "DRAFT" | "DISPATCHED" | "RECEIVED" | "CANCELLED";

export interface IndentItemDto {
  id: string;
  rawMaterialId: string;
  materialName: string;
  unit: MaterialUnit;
  requestedQty: number;
  dispatchedQty: number;
}

export interface EwayBillDto {
  id: string;
  ewbNo: string;
  value: number;
  fromGstin: string | null;
  toGstin: string | null;
  distanceKm: number | null;
  validUntil: string | null;
  status: string;
  generatedAt: string;
}

export interface IndentDto {
  id: string;
  direction: "incoming" | "outgoing"; // relative to the viewing outlet
  fromOutletId: string;
  fromOutletName: string;
  toOutletId: string;
  toOutletName: string;
  status: IndentStatus;
  note: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
  value: number;
  items: IndentItemDto[];
  ewayBill: EwayBillDto | null;
}

/** Tells the console what role the viewed outlet plays in the supply chain. */
export interface CentralKitchenContextDto {
  role: "central" | "satellite" | "none";
  centralKitchen: { id: string; name: string } | null;
  satellites: { id: string; name: string }[];
  // materials available at the central kitchen (for a satellite to request)
  centralMaterials: { id: string; name: string; unit: MaterialUnit; stockQty: number }[];
}

// ---------- Scan & Order (first-party online ordering) ----------

export interface PublicMenuDto {
  outletName: string;
  mode: "DINE_IN" | "TAKEAWAY";
  tableName: string | null;
  categories: MenuCategoryDto[];
  themeId: string;
}

// What the diner polls after submitting: their request's fate + token number.
export interface OrderRequestStatusDto {
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  tokenNumber: number | null;
}

// A pending request as staff sees it in the validation queue.
export interface OrderRequestDto {
  id: string;
  mode: "DINE_IN" | "TAKEAWAY";
  tableName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  note: string | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  tokenNumber: number | null;
  createdAt: string;
  items: { name: string; variationName: string | null; addonNames: string[]; quantity: number; note: string | null }[];
  total: number;
}

// A per-table Scan & Order QR target, listed in the dashboard.
export interface TableQrDto {
  tableId: string;
  tableName: string;
  areaName: string;
  token: string;
}

// The customer-facing token-display board: which numbers are cooking vs ready.
export interface TokenBoardDto {
  outletName: string;
  preparing: number[];
  ready: number[];
  themeId: string;
}

// Mock hardware bridge readings (weighing scale, caller-ID).
export interface ScaleReadingDto {
  grams: number;
  stable: boolean;
}
export interface CallerIdDto {
  phone: string;
  customerName: string | null;
  lastVisitAt: string | null;
  totalOrders: number;
}

// ---------- Device fleet management ----------

export type DeviceType = "POS" | "KDS" | "PRINTER" | "KIOSK" | "DISPLAY";

export interface DeviceDto {
  id: string;
  name: string;
  type: DeviceType;
  isActive: boolean;
  lastSeenAt: string | null;
  deviceToken: string;
  config: Record<string, unknown>;
}

// A downloadable config snapshot of an outlet (menu, tables, fleet).
export interface OutletBackupDto {
  generatedAt: string;
  outlet: { id: string; name: string; gstin: string | null };
  counts: {
    categories: number;
    items: number;
    combos: number;
    tables: number;
    devices: number;
    materials: number;
  };
  devices: { name: string; type: DeviceType; config: Record<string, unknown> }[];
  menu: { category: string; items: { name: string; price: number }[] }[];
  tables: { area: string; name: string }[];
}

// ---------- Onboarding wizard ----------

export interface TenantSummaryDto {
  id: string;
  name: string;
  status: string;
  createdVia: string;
  onboardedAt: string | null;
}
