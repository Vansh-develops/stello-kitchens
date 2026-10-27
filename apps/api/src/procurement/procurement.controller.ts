import { Body, Controller, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import {
  CreatePurchaseOrderSchema,
  CreateStockCountSchema,
  MaterialPlanningSchema,
  PoActionSchema,
  ProcurementSettingsSchema,
  ProcurementVendorSchema,
  ReceiveGrnSchema,
  StockCountEntriesSchema,
  SuggestionsToPosSchema,
  SupplierBillSchema,
  SupplierPaymentSchema,
  UpdatePurchaseOrderSchema,
  type AuthUser,
  type CreatePurchaseOrderInput,
  type CreateStockCountInput,
  type MaterialPlanningInput,
  type PoActionInput,
  type ProcurementSettingsInput,
  type ProcurementVendorInput,
  type ReceiveGrnInput,
  type StockCountEntriesInput,
  type SuggestionsToPosInput,
  type SupplierBillInput,
  type SupplierPaymentInput,
  type UpdatePurchaseOrderInput,
} from "@stello/shared";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { PurchaseOrdersService } from "./purchase-orders.service";
import { PayablesService } from "./payables.service";
import { StocktakeService } from "./stocktake.service";
import { PlanningService } from "./planning.service";
import { InsightsService } from "./insights.service";

const clamp = (v: string | undefined, def: number, min: number, max: number) =>
  Math.min(Math.max(Number(v) || def, min), max);

function dayStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

@RequirePermission("purchase.manage")
@Controller("outlets/:outletId/procurement")
export class ProcurementController {
  constructor(
    private readonly pos: PurchaseOrdersService,
    private readonly planning: PlanningService,
  ) {}

  // Settings
  @Get("settings")
  settings(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.pos.getSettings(user, outletId);
  }

  @RequirePermission("purchase.manage", "purchase.approve")
  @Put("settings")
  saveSettings(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(ProcurementSettingsSchema)) body: ProcurementSettingsInput,
  ) {
    return this.pos.saveSettings(user, outletId, body);
  }

  // Vendors
  @Get("vendors")
  vendors(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.pos.listVendors(user, outletId);
  }

  @Post("vendors")
  createVendor(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(ProcurementVendorSchema)) body: ProcurementVendorInput,
  ) {
    return this.pos.createVendor(user, outletId, body);
  }

  @Patch("vendors/:id")
  updateVendor(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ProcurementVendorSchema)) body: ProcurementVendorInput,
  ) {
    return this.pos.updateVendor(user, outletId, id, body);
  }

  @Get("price-history")
  priceHistory(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("vendorId") vendorId?: string,
    @Query("materialId") materialId?: string,
  ) {
    return this.pos.priceHistory(user, outletId, { vendorId, materialId });
  }

  // Purchase orders
  @Get("purchase-orders")
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("status") status?: string) {
    return this.pos.list(user, outletId, status);
  }

  @Get("purchase-orders/:id")
  get(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.pos.get(user, outletId, id);
  }

  @Post("purchase-orders")
  create(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreatePurchaseOrderSchema)) body: CreatePurchaseOrderInput,
  ) {
    return this.pos.create(user, outletId, body);
  }

  @Patch("purchase-orders/:id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdatePurchaseOrderSchema)) body: UpdatePurchaseOrderInput,
  ) {
    return this.pos.update(user, outletId, id, body);
  }

  /** approve needs purchase.approve as well (checked in the service). */
  @Post("purchase-orders/:id/actions")
  act(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PoActionSchema)) body: PoActionInput,
  ) {
    return this.pos.act(user, outletId, id, body);
  }

  @Post("purchase-orders/:id/receive")
  receive(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReceiveGrnSchema)) body: ReceiveGrnInput,
  ) {
    return this.pos.receive(user, outletId, id, body);
  }

  @Get("receipts")
  receipts(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.pos.listReceipts(user, outletId);
  }

  // Reorder / par levels and suggestions
  @Get("planning")
  listPlanning(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.planning.listPlanning(user, outletId);
  }

  @Put("planning")
  savePlanning(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(MaterialPlanningSchema)) body: MaterialPlanningInput,
  ) {
    return this.planning.savePlanning(user, outletId, body);
  }

  @Get("suggestions")
  suggestions(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.planning.suggestions(user, outletId);
  }

  @Post("suggestions/purchase-orders")
  suggestionsToPos(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(SuggestionsToPosSchema)) body: SuggestionsToPosInput,
  ) {
    return this.planning.createPurchaseOrders(user, outletId, body);
  }

  // Forecasting
  @Get("forecast")
  forecast(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("days") days?: string) {
    return this.planning.forecast(user, outletId, clamp(days, 7, 1, 28));
  }

  @Get("forecast/accuracy")
  accuracy(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("days") days?: string) {
    return this.planning.accuracy(user, outletId, clamp(days, 14, 7, 56));
  }
}

@RequirePermission("payables.manage")
@Controller("outlets/:outletId/payables")
export class PayablesController {
  constructor(private readonly svc: PayablesService) {}

  @Get()
  summary(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.payables(user, outletId);
  }

  @Get("bills")
  bills(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("vendorId") vendorId?: string,
    @Query("status") status?: string,
  ) {
    return this.svc.listBills(user, outletId, { vendorId, status });
  }

  @Post("bills")
  createBill(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(SupplierBillSchema)) body: SupplierBillInput,
  ) {
    return this.svc.createBill(user, outletId, body);
  }

  @Post("bills/:id/void")
  voidBill(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.voidBill(user, outletId, id);
  }

  @Get("payments")
  payments(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("vendorId") vendorId?: string) {
    return this.svc.listPayments(user, outletId, vendorId);
  }

  @Post("payments")
  pay(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(SupplierPaymentSchema)) body: SupplierPaymentInput,
  ) {
    return this.svc.recordPayment(user, outletId, body);
  }
}

@RequirePermission("stocktake.count")
@Controller("outlets/:outletId/stocktakes")
export class StocktakeController {
  constructor(private readonly svc: StocktakeService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.list(user, outletId);
  }

  @Get("categories")
  categories(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.categories(user, outletId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateStockCountSchema)) body: CreateStockCountInput,
  ) {
    return this.svc.create(user, outletId, body);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.get(user, outletId, id);
  }

  @Put(":id/counts")
  counts(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(StockCountEntriesSchema)) body: StockCountEntriesInput,
  ) {
    return this.svc.enterCounts(user, outletId, id, body);
  }

  @Post(":id/submit")
  submit(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.submit(user, outletId, id);
  }

  @Post(":id/cancel")
  cancel(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.cancel(user, outletId, id);
  }

  @RequirePermission("stocktake.approve")
  @Post(":id/post")
  post(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.post(user, outletId, id);
  }
}

@RequirePermission("reports.view")
@Controller("outlets/:outletId/reports")
export class InsightsController {
  constructor(private readonly svc: InsightsService) {}

  @Get("menu-engineering")
  menuEngineering(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("categoryId") categoryId?: string,
  ) {
    const valid = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
    return this.svc.menuEngineering(user, outletId, valid(from) ?? dayStr(-29), valid(to) ?? dayStr(), categoryId || undefined);
  }
}
