import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import {
  AddonGroupSchema,
  ChannelSchema,
  CreateCategorySchema,
  CreateItemSchema,
  UpdateCategorySchema,
  UpdateItemSchema,
  type AddonGroupInput,
  type AuthUser,
  type ChannelInput,
  type CreateCategoryInput,
  type CreateItemInput,
  type UpdateCategoryInput,
  type UpdateItemInput,
} from "@petpooja/shared";
import { MenuAdminService } from "./menu-admin.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@RequirePermission("menu.manage")
@Controller("outlets/:outletId")
export class MenuAdminController {
  constructor(private readonly svc: MenuAdminService) {}

  @Get("menu/admin")
  adminMenu(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.adminMenu(user, outletId);
  }

  // Categories
  @Post("menu/categories")
  createCategory(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateCategorySchema)) body: CreateCategoryInput,
  ) {
    return this.svc.createCategory(user, outletId, body);
  }

  @Patch("menu/categories/:id")
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateCategorySchema)) body: UpdateCategoryInput,
  ) {
    return this.svc.updateCategory(user, outletId, id, body);
  }

  @Delete("menu/categories/:id")
  deleteCategory(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
  ) {
    return this.svc.deleteCategory(user, outletId, id);
  }

  // Items
  @Post("menu/items")
  createItem(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateItemSchema)) body: CreateItemInput,
  ) {
    return this.svc.createItem(user, outletId, body);
  }

  @Patch("menu/items/:id")
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateItemSchema)) body: UpdateItemInput,
  ) {
    return this.svc.updateItem(user, outletId, id, body);
  }

  @Delete("menu/items/:id")
  deleteItem(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
  ) {
    return this.svc.deleteItem(user, outletId, id);
  }

  // Addon groups
  @Post("menu/addon-groups")
  createAddonGroup(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(AddonGroupSchema)) body: AddonGroupInput,
  ) {
    return this.svc.createAddonGroup(user, outletId, body);
  }

  @Patch("menu/addon-groups/:id")
  updateAddonGroup(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AddonGroupSchema)) body: AddonGroupInput,
  ) {
    return this.svc.updateAddonGroup(user, outletId, id, body);
  }

  @Delete("menu/addon-groups/:id")
  deleteAddonGroup(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
  ) {
    return this.svc.deleteAddonGroup(user, outletId, id);
  }

  // Channels
  @Post("channels")
  createChannel(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(ChannelSchema)) body: ChannelInput,
  ) {
    return this.svc.createChannel(user, outletId, body);
  }

  @Patch("channels/:id")
  updateChannel(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ChannelSchema.partial())) body: Partial<ChannelInput>,
  ) {
    return this.svc.updateChannel(user, outletId, id, body);
  }

  @Delete("channels/:id")
  deleteChannel(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
  ) {
    return this.svc.deleteChannel(user, outletId, id);
  }
}
