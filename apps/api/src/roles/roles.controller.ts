import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import {
  AssignRoleSchema,
  PERMISSIONS,
  RoleInputSchema,
  type AssignRoleInput,
  type AuthUser,
  type RoleInput,
} from "@stello/shared";
import { RolesService } from "./roles.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@RequirePermission("roles.manage")
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** The permission catalogue (also importable from @stello/shared). */
  @Get("permissions")
  catalogue() {
    return PERMISSIONS;
  }

  @Get("roles")
  list(@CurrentUser() user: AuthUser) {
    return this.roles.list(user);
  }

  @Post("roles")
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(RoleInputSchema)) body: RoleInput) {
    return this.roles.create(user, body);
  }

  @Patch("roles/:id")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(RoleInputSchema)) body: RoleInput) {
    return this.roles.update(user, id, body);
  }

  @Delete("roles/:id")
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.roles.remove(user, id);
  }

  @Get("staff")
  staff(@CurrentUser() user: AuthUser) {
    return this.roles.staff(user);
  }

  @Patch("staff/:id/role")
  assign(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(AssignRoleSchema)) body: AssignRoleInput) {
    return this.roles.assign(user, id, body.roleId);
  }
}
