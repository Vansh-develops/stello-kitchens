import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  ExpenseCategorySchema,
  ExpenseSchema,
  ReasonSchema,
  addDays,
  istDateOf,
  type AuthUser,
  type ExpenseCategoryInput,
  type ExpenseInput,
} from "@stello/shared";
import { FinanceService } from "./finance.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function range(from?: string, to?: string, days = 30) {
  const t = to || istDateOf(new Date());
  const f = from || addDays(t, -(days - 1));
  if (!DATE_RE.test(f) || !DATE_RE.test(t)) throw new BadRequestException("Dates must be YYYY-MM-DD");
  return { from: f, to: t };
}

@Controller()
export class FinanceController {
  constructor(private readonly svc: FinanceService) {}

  // ---------- Expense categories (tenant-wide) ----------

  @RequirePermission("expenses.manage")
  @Get("expense-categories")
  categories(@CurrentUser() user: AuthUser) {
    return this.svc.categories(user);
  }

  @RequirePermission("expenses.manage")
  @Post("expense-categories")
  createCategory(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(ExpenseCategorySchema)) body: ExpenseCategoryInput) {
    return this.svc.createCategory(user, body);
  }

  @RequirePermission("expenses.manage")
  @Patch("expense-categories/:id")
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ExpenseCategorySchema.partial())) body: Partial<ExpenseCategoryInput>,
  ) {
    return this.svc.updateCategory(user, id, body);
  }

  // ---------- Expenses ----------

  @RequirePermission("expenses.manage")
  @Get("outlets/:outletId/expenses")
  expenses(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("from") from?: string, @Query("to") to?: string) {
    const r = range(from, to);
    return this.svc.listExpenses(user, outletId, r.from, r.to);
  }

  @RequirePermission("expenses.manage")
  @Post("outlets/:outletId/expenses")
  createExpense(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(ExpenseSchema)) body: ExpenseInput,
  ) {
    return this.svc.createExpense(user, outletId, body);
  }

  @RequirePermission("expenses.manage")
  @Post("outlets/:outletId/expenses/:id/void")
  voidExpense(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReasonSchema)) body: { reason: string },
  ) {
    return this.svc.voidExpense(user, outletId, id, body.reason);
  }

  // ---------- Reports ----------

  @RequirePermission("finance.manage")
  @Get("outlets/:outletId/finance/pnl")
  pnl(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("compare") compare?: string,
  ) {
    const r = range(from, to);
    const mode = compare === "yoy" || compare === "none" ? compare : "prev";
    return this.svc.pnl(user, outletId, r.from, r.to, mode);
  }

  @RequirePermission("finance.manage")
  @Get("outlets/:outletId/finance/day-book")
  dayBook(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("from") from?: string, @Query("to") to?: string) {
    const r = range(from, to, 1);
    return this.svc.dayBook(user, outletId, r.from, r.to);
  }

  @RequirePermission("finance.manage")
  @Get("outlets/:outletId/exports/tally-expenses")
  async tally(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("from") from?: string, @Query("to") to?: string) {
    const r = range(from, to);
    const xml = await this.svc.tallyExpenses(user, outletId, r.from, r.to);
    return { filename: `tally-expenses-${r.from}-to-${r.to}.xml`, xml };
  }
}
