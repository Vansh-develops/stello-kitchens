import { Controller, Get, Param, Query } from "@nestjs/common";
import { AuditQuerySchema, type AuditQueryInput, type AuthUser } from "@stello/shared";
import { AuditService } from "./audit.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@RequirePermission("audit.view")
@Controller("audit-logs")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  page(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(AuditQuerySchema)) q: AuditQueryInput) {
    return this.audit.page(user, q);
  }

  @Get("facets")
  facets(@CurrentUser() user: AuthUser) {
    return this.audit.facets(user);
  }

  @Get(":id")
  one(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.audit.one(user, id);
  }
}
