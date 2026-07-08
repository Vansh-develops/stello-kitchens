import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import {
  CreateMaterialSchema,
  ProduceBatchSchema,
  ReceiveStockSchema,
  SetPrepRecipeSchema,
  SetRecipeSchema,
  UpdateMaterialSchema,
  VendorSchema,
  WastageSchema,
  type AuthUser,
  type CreateMaterialInput,
  type ProduceBatchInput,
  type ReceiveStockInput,
  type SetPrepRecipeInput,
  type SetRecipeInput,
  type UpdateMaterialInput,
  type VendorInput,
  type WastageInput,
} from "@stello/shared";
import { InventoryService } from "./inventory.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller("outlets/:outletId")
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  // Materials
  @Get("inventory/materials")
  materials(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.listMaterials(user, outletId);
  }

  @RequirePermission("inventory.manage")
  @Post("inventory/materials")
  createMaterial(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateMaterialSchema)) body: CreateMaterialInput,
  ) {
    return this.svc.createMaterial(user, outletId, body);
  }

  @RequirePermission("inventory.manage")
  @Patch("inventory/materials/:id")
  updateMaterial(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateMaterialSchema)) body: UpdateMaterialInput,
  ) {
    return this.svc.updateMaterial(user, outletId, id, body);
  }

  @RequirePermission("inventory.manage")
  @Delete("inventory/materials/:id")
  deleteMaterial(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
  ) {
    return this.svc.deleteMaterial(user, outletId, id);
  }

  @RequirePermission("inventory.manage")
  @Post("inventory/materials/:id/receive")
  receive(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReceiveStockSchema)) body: ReceiveStockInput,
  ) {
    return this.svc.receiveStock(user, outletId, id, body);
  }

  @RequirePermission("inventory.manage")
  @Post("inventory/materials/:id/wastage")
  wastage(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(WastageSchema)) body: WastageInput,
  ) {
    return this.svc.recordWastage(user, outletId, id, body);
  }

  // Vendors
  @Get("inventory/vendors")
  vendors(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.listVendors(user, outletId);
  }

  @RequirePermission("inventory.manage")
  @Post("inventory/vendors")
  createVendor(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(VendorSchema)) body: VendorInput,
  ) {
    return this.svc.createVendor(user, outletId, body);
  }

  @RequirePermission("inventory.manage")
  @Delete("inventory/vendors/:id")
  deleteVendor(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
  ) {
    return this.svc.deleteVendor(user, outletId, id);
  }

  // Recipes & costing
  @Get("menu/items/:itemId/recipe")
  recipe(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("itemId") itemId: string,
  ) {
    return this.svc.getRecipe(user, outletId, itemId);
  }

  @RequirePermission("inventory.manage")
  @Put("menu/items/:itemId/recipe")
  setRecipe(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("itemId") itemId: string,
    @Body(new ZodValidationPipe(SetRecipeSchema)) body: SetRecipeInput,
  ) {
    return this.svc.setRecipe(user, outletId, itemId, body);
  }

  // Multi-stage recipes (semi-finished goods)
  @Get("inventory/materials/:id/prep-recipe")
  prepRecipe(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
  ) {
    return this.svc.getPrepRecipe(user, outletId, id);
  }

  @RequirePermission("inventory.manage")
  @Put("inventory/materials/:id/prep-recipe")
  setPrepRecipe(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetPrepRecipeSchema)) body: SetPrepRecipeInput,
  ) {
    return this.svc.setPrepRecipe(user, outletId, id, body);
  }

  @RequirePermission("inventory.manage")
  @Post("inventory/materials/:id/produce")
  produce(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ProduceBatchSchema)) body: ProduceBatchInput,
  ) {
    return this.svc.produceBatch(user, outletId, id, body);
  }

  @Get("inventory/costing")
  costing(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.itemsCosting(user, outletId);
  }

  @Get("inventory/consumption")
  consumption(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("days") days?: string,
  ) {
    return this.svc.consumption(user, outletId, Math.min(Math.max(Number(days) || 7, 1), 90));
  }

  @Get("inventory/movements")
  movements(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.recentMovements(user, outletId);
  }
}
