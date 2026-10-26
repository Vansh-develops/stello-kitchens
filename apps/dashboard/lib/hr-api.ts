import type {
  AttendanceCorrectionInput,
  AttendanceRecordDto,
  AttendanceRegisterDto,
  ClockActionInput,
  ClockStaffDto,
  DailyAttendanceDto,
  DayBookDto,
  DecisionInput,
  ExpenseCategoryDto,
  ExpenseCategoryInput,
  ExpenseDto,
  ExpenseInput,
  GiftCardBalanceDto,
  GiftCardDetailDto,
  GiftCardDto,
  IssueGiftCardInput,
  LeaveBalanceDto,
  LeaveBalanceInput,
  LeaveRequestDto,
  LeaveRequestInput,
  PayrollConfig,
  PayrollRunDto,
  PayrollRunRowDto,
  PayslipDto,
  PnlDto,
  RosterAssignInput,
  RosterWeekDto,
  SalaryAdvanceDto,
  SalaryAdvanceInput,
  ShiftTemplateDto,
  ShiftTemplateInput,
  StaffDto,
  StaffInput,
  StaffSalesRowDto,
  SwapRequestDto,
  SwapRequestInput,
  UpdatePayslipInput,
  UpdateStaffInput,
} from "@stello/shared";
import { request } from "./api";

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const o = (outletId: string) => `/outlets/${outletId}`;

// Staff/HR, payroll, accounting (expenses/P&L/day book) and gift card endpoints.
export const hrApi = {
  // Staff profiles
  staff: (outletId: string) => request<StaffDto[]>(`${o(outletId)}/staff`),
  linkableUsers: (outletId: string) => request<{ id: string; name: string; email: string }[]>(`${o(outletId)}/staff/linkable-users`),
  createStaff: (outletId: string, input: StaffInput) => request<StaffDto>(`${o(outletId)}/staff`, json("POST", input)),
  updateStaff: (outletId: string, id: string, input: UpdateStaffInput) => request<StaffDto>(`${o(outletId)}/staff/${id}`, json("PATCH", input)),
  setPin: (outletId: string, id: string, pin: string) => request<{ ok: true }>(`${o(outletId)}/staff/${id}/pin`, json("PUT", { pin })),

  // Clock (POS)
  clockBoard: (outletId: string) => request<ClockStaffDto[]>(`${o(outletId)}/clock/staff`),
  clock: (outletId: string, input: ClockActionInput) => request<ClockStaffDto>(`${o(outletId)}/clock`, json("POST", input)),

  // Attendance
  daily: (outletId: string, date: string) => request<DailyAttendanceDto>(`${o(outletId)}/attendance/daily?date=${date}`),
  register: (outletId: string, from: string, to: string) =>
    request<AttendanceRegisterDto>(`${o(outletId)}/attendance/register?from=${from}&to=${to}`),
  correct: (outletId: string, input: AttendanceCorrectionInput) =>
    request<AttendanceRecordDto>(`${o(outletId)}/attendance/corrections`, json("POST", input)),

  // Roster
  templates: (outletId: string) => request<ShiftTemplateDto[]>(`${o(outletId)}/shift-templates`),
  createTemplate: (outletId: string, input: ShiftTemplateInput) => request<ShiftTemplateDto>(`${o(outletId)}/shift-templates`, json("POST", input)),
  deleteTemplate: (outletId: string, id: string) => request<{ id: string }>(`${o(outletId)}/shift-templates/${id}`, json("DELETE")),
  roster: (outletId: string, weekStart: string) => request<RosterWeekDto>(`${o(outletId)}/roster?weekStart=${weekStart}`),
  assignRoster: (outletId: string, input: RosterAssignInput) => request<{ updated: number }>(`${o(outletId)}/roster`, json("PUT", input)),
  copyRoster: (outletId: string, fromWeekStart: string, toWeekStart: string) =>
    request<{ copied: number }>(`${o(outletId)}/roster/copy`, json("POST", { fromWeekStart, toWeekStart })),
  swaps: (outletId: string) => request<SwapRequestDto[]>(`${o(outletId)}/shift-swaps`),
  requestSwap: (outletId: string, input: SwapRequestInput) => request<{ id: string }>(`${o(outletId)}/shift-swaps`, json("POST", input)),
  decideSwap: (outletId: string, id: string, input: DecisionInput) => request<{ id: string }>(`${o(outletId)}/shift-swaps/${id}/decide`, json("POST", input)),

  // Leave
  leaves: (outletId: string) => request<LeaveRequestDto[]>(`${o(outletId)}/leave`),
  requestLeave: (outletId: string, input: LeaveRequestInput) => request<{ id: string }>(`${o(outletId)}/leave`, json("POST", input)),
  decideLeave: (outletId: string, id: string, input: DecisionInput) => request<{ id: string }>(`${o(outletId)}/leave/${id}/decide`, json("POST", input)),
  cancelLeave: (outletId: string, id: string) => request<{ id: string }>(`${o(outletId)}/leave/${id}/cancel`, json("POST")),
  leaveBalances: (outletId: string, year: number) => request<LeaveBalanceDto[]>(`${o(outletId)}/leave-balances?year=${year}`),
  setLeaveBalance: (outletId: string, input: LeaveBalanceInput) => request<{ ok: true }>(`${o(outletId)}/leave-balances`, json("PUT", input)),

  // Payroll
  payrollConfig: (outletId: string) => request<PayrollConfig>(`${o(outletId)}/payroll/settings`),
  setPayrollConfig: (outletId: string, config: PayrollConfig) => request<PayrollConfig>(`${o(outletId)}/payroll/settings`, json("PUT", config)),
  advances: (outletId: string) => request<SalaryAdvanceDto[]>(`${o(outletId)}/payroll/advances`),
  giveAdvance: (outletId: string, input: SalaryAdvanceInput) => request<{ id: string }>(`${o(outletId)}/payroll/advances`, json("POST", input)),
  payrollRuns: (outletId: string) => request<PayrollRunRowDto[]>(`${o(outletId)}/payroll/runs`),
  computePayroll: (outletId: string, month: string) => request<PayrollRunDto>(`${o(outletId)}/payroll/runs`, json("POST", { month })),
  payrollRun: (outletId: string, id: string) => request<PayrollRunDto>(`${o(outletId)}/payroll/runs/${id}`),
  updatePayslip: (outletId: string, runId: string, payslipId: string, input: UpdatePayslipInput) =>
    request<PayslipDto>(`${o(outletId)}/payroll/runs/${runId}/payslips/${payslipId}`, json("PATCH", input)),
  finalisePayroll: (outletId: string, id: string) => request<PayrollRunDto>(`${o(outletId)}/payroll/runs/${id}/finalise`, json("POST")),
  deletePayroll: (outletId: string, id: string) => request<{ id: string }>(`${o(outletId)}/payroll/runs/${id}`, json("DELETE")),
  payrollCsv: (outletId: string, id: string) => request<{ filename: string; csv: string }>(`${o(outletId)}/payroll/runs/${id}/csv`),
  staffSales: (outletId: string, from: string, to: string) =>
    request<StaffSalesRowDto[]>(`${o(outletId)}/reports/staff-sales?from=${from}&to=${to}`),

  // Accounting
  expenseCategories: () => request<ExpenseCategoryDto[]>(`/expense-categories`),
  createExpenseCategory: (input: ExpenseCategoryInput) => request<ExpenseCategoryDto>(`/expense-categories`, json("POST", input)),
  updateExpenseCategory: (id: string, input: Partial<ExpenseCategoryInput>) =>
    request<ExpenseCategoryDto>(`/expense-categories/${id}`, json("PATCH", input)),
  expenses: (outletId: string, from: string, to: string) => request<ExpenseDto[]>(`${o(outletId)}/expenses?from=${from}&to=${to}`),
  createExpense: (outletId: string, input: ExpenseInput) => request<ExpenseDto>(`${o(outletId)}/expenses`, json("POST", input)),
  voidExpense: (outletId: string, id: string, reason: string) => request<ExpenseDto>(`${o(outletId)}/expenses/${id}/void`, json("POST", { reason })),
  pnl: (outletId: string, from: string, to: string, compare: "prev" | "yoy" | "none") =>
    request<PnlDto>(`${o(outletId)}/finance/pnl?from=${from}&to=${to}&compare=${compare}`),
  dayBook: (outletId: string, from: string, to: string) => request<DayBookDto>(`${o(outletId)}/finance/day-book?from=${from}&to=${to}`),
  tallyExpenses: (outletId: string, from: string, to: string) =>
    request<{ filename: string; xml: string }>(`${o(outletId)}/exports/tally-expenses?from=${from}&to=${to}`),

  // Gift cards
  giftCards: (q?: string) => request<GiftCardDto[]>(`/gift-cards${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  giftCard: (id: string) => request<GiftCardDetailDto>(`/gift-cards/${id}`),
  issueGiftCard: (outletId: string, input: IssueGiftCardInput) => request<GiftCardDto>(`${o(outletId)}/gift-cards`, json("POST", input)),
  voidGiftCard: (id: string, reason: string) => request<GiftCardDto>(`/gift-cards/${id}/void`, json("POST", { reason })),
  giftCardBalance: (outletId: string, code: string) =>
    request<GiftCardBalanceDto>(`${o(outletId)}/gift-cards/balance?code=${encodeURIComponent(code)}`),
};

/** Trigger a browser download of text content. */
export function downloadText(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;

/** Today's date in IST as YYYY-MM-DD. */
export function todayIst(): string {
  const d = new Date(Date.now() + 330 * 60000);
  return d.toISOString().slice(0, 10);
}
export const timeIst = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
