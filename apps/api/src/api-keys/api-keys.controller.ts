import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ApiKeyCreateSchema, type ApiKeyCreateInput, type AuthUser } from "@stello/shared";
import { ApiKeyService } from "./api-key.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@RequirePermission("integrations.manage")
@Controller("integrations/api-keys")
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.keys.list(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(ApiKeyCreateSchema)) body: ApiKeyCreateInput) {
    return this.keys.create(user, body);
  }

  @Delete(":id")
  revoke(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.keys.revoke(user, id);
  }
}
