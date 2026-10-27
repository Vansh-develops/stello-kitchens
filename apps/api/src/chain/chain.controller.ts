import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import {
  CreateChainOutletSchema,
  ImportMasterSchema,
  MasterAddonGroupSchema,
  MasterCategorySchema,
  MasterComboSchema,
  MasterItemSchema,
  MasterOverrideSchema,
  PublishMenuSchema,
  UpdateMasterItemSchema,
  type AuthUser,
  type CreateChainOutletInput,
  type ImportMasterInput,
  type MasterAddonGroupInput,
  type MasterCategoryInput,
  type MasterComboInput,
  type MasterItemInput,
  type MasterOverrideInput,
  type PublishMenuInput,
  type UpdateMasterItemInput,
} from "@stello/shared";
import { ChainService } from "./chain.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { PlanLimit, RequireFeature } from "../saas-billing/plan.guard";

// Brand admins: the master menu and publishing it to outlets.
@RequirePermission("chain.manage")
@RequireFeature("chain_menu")
@Controller("chain/brands")
export class ChainController {
  constructor(private readonly svc: ChainService) {}

  @Get()
  brands(@CurrentUser() user: AuthUser) {
    return this.svc.brands(user);
  }

  @Get(":brandId/menu")
  menu(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string) {
    return this.svc.masterMenu(user, brandId);
  }

  @Post(":brandId/import")
  import(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Body(new ZodValidationPipe(ImportMasterSchema)) body: ImportMasterInput,
  ) {
    return this.svc.importFromOutlet(user, brandId, body.outletId);
  }

  @Post(":brandId/categories")
  createCategory(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Body(new ZodValidationPipe(MasterCategorySchema)) body: MasterCategoryInput,
  ) {
    return this.svc.createCategory(user, brandId, body);
  }

  @Patch(":brandId/categories/:id")
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(MasterCategorySchema.partial())) body: Partial<MasterCategoryInput>,
  ) {
    return this.svc.updateCategory(user, brandId, id, body);
  }

  @Delete(":brandId/categories/:id")
  deleteCategory(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Param("id") id: string) {
    return this.svc.deleteCategory(user, brandId, id);
  }

  @Post(":brandId/items")
  createItem(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Body(new ZodValidationPipe(MasterItemSchema)) body: MasterItemInput,
  ) {
    return this.svc.createItem(user, brandId, body);
  }

  @Patch(":brandId/items/:id")
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateMasterItemSchema)) body: UpdateMasterItemInput,
  ) {
    return this.svc.updateItem(user, brandId, id, body);
  }

  @Delete(":brandId/items/:id")
  deleteItem(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Param("id") id: string) {
    return this.svc.deleteItem(user, brandId, id);
  }

  @Post(":brandId/addon-groups")
  createAddonGroup(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Body(new ZodValidationPipe(MasterAddonGroupSchema)) body: MasterAddonGroupInput,
  ) {
    return this.svc.createAddonGroup(user, brandId, body);
  }

  @Patch(":brandId/addon-groups/:id")
  updateAddonGroup(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(MasterAddonGroupSchema)) body: MasterAddonGroupInput,
  ) {
    return this.svc.updateAddonGroup(user, brandId, id, body);
  }

  @Delete(":brandId/addon-groups/:id")
  deleteAddonGroup(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Param("id") id: string) {
    return this.svc.deleteAddonGroup(user, brandId, id);
  }

  @Post(":brandId/combos")
  createCombo(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Body(new ZodValidationPipe(MasterComboSchema)) body: MasterComboInput,
  ) {
    return this.svc.createCombo(user, brandId, body);
  }

  @Patch(":brandId/combos/:id")
  updateCombo(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(MasterComboSchema)) body: MasterComboInput,
  ) {
    return this.svc.updateCombo(user, brandId, id, body);
  }

  @Delete(":brandId/combos/:id")
  deleteCombo(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Param("id") id: string) {
    return this.svc.deleteCombo(user, brandId, id);
  }

  @Post(":brandId/publish/preview")
  preview(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Body(new ZodValidationPipe(PublishMenuSchema)) body: PublishMenuInput,
  ) {
    return this.svc.preview(user, brandId, body.outletIds);
  }

  @Post(":brandId/publish")
  publish(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Body(new ZodValidationPipe(PublishMenuSchema)) body: PublishMenuInput,
  ) {
    return this.svc.publish(user, brandId, body.outletIds);
  }

  @Get(":brandId/publications")
  publications(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string) {
    return this.svc.publications(user, brandId);
  }

  @PlanLimit("outlets")
  @Post(":brandId/outlets")
  createOutlet(
    @CurrentUser() user: AuthUser,
    @Param("brandId") brandId: string,
    @Body(new ZodValidationPipe(CreateChainOutletSchema)) body: CreateChainOutletInput,
  ) {
    return this.svc.createOutlet(user, brandId, body);
  }
}

// Outlet managers: per-outlet overrides of master items.
@RequirePermission("menu.manage")
@Controller("outlets/:outletId/master-overrides")
export class MasterOverridesController {
  constructor(private readonly svc: ChainService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.overrides(user, outletId);
  }

  @Put(":masterItemId")
  set(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("masterItemId") masterItemId: string,
    @Body(new ZodValidationPipe(MasterOverrideSchema)) body: MasterOverrideInput,
  ) {
    return this.svc.setOverride(user, outletId, masterItemId, body);
  }
}
