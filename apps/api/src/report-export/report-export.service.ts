import { BadRequestException, Injectable } from "@nestjs/common";
import {
  REPORT_EXPORTS,
  type AuthUser,
  type BreakdownRowDto,
  type CustomReportDto,
  type CustomReportInput,
  type ReportExportKey,
} from "@stello/shared";
import { ReportsService } from "../reports/reports.service";
import { CashService } from "../payments/cash.service";
import type { Sheet } from "./report-writer";

const LABEL = Object.fromEntries(REPORT_EXPORTS.map((r) => [r.key, r.label])) as Record<ReportExportKey, string>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function shareSheet(name: string, rows: BreakdownRowDto[], countHeader = "Count"): Sheet {
  return {
    name,
    columns: [{ header: name.replace(/s$/, ""), width: 24 }, { header: "Amount (₹)", format: "money" }, { header: countHeader, format: "int" }, { header: "Share", format: "pct" }],
    rows: rows.map((r) => [r.label, r.amount, r.count, r.share]),
  };
}

/**
 * Turns every report the console shows into tabular sheets, reusing
 * ReportsService/CashService so exported numbers are exactly the on-screen ones.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly reports: ReportsService,
    private readonly cash: CashService,
  ) {}

  assertRange(from: string, to: string) {
    if (!DATE.test(from) || !DATE.test(to)) throw new BadRequestException("from/to must be YYYY-MM-DD");
    if (from > to) throw new BadRequestException("from must be on or before to");
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
    if (days > 366) throw new BadRequestException("Export at most one year at a time");
  }

  async sheets(user: AuthUser, outletId: string, keys: ReportExportKey[], from: string, to: string): Promise<Sheet[]> {
    this.assertRange(from, to);
    const out: Sheet[] = [];
    const needsBreakdown = keys.some((k) => ["payments", "order-types", "categories", "top-items", "tax"].includes(k));
    const breakdown = needsBreakdown ? await this.reports.breakdown(user, outletId, from, to) : null;
    for (const key of keys) {
      switch (key) {
        case "overview": {
          const o = await this.reports.overview(user, outletId, from, to);
          out.push({
            name: "Summary",
            columns: [{ header: "Metric", width: 22 }, { header: "Value", format: "money" }],
            rows: [
              ["From", o.from],
              ["To", o.to],
              ["Gross sales (₹)", o.grossSales],
              ["Net sales (₹)", o.netSales],
              ["Orders", o.orders],
              ["Avg order value (₹)", o.avgOrderValue],
              ["Tax collected (₹)", o.taxCollected],
              ["Discounts (₹)", o.discountsGiven],
              ["New customers", o.newCustomers],
            ],
          });
          out.push({
            name: "Sales by day",
            columns: [{ header: "Date" }, { header: "Sales (₹)", format: "money" }, { header: "Orders", format: "int" }],
            rows: o.series.map((s) => [s.date, s.sales, s.orders]),
          });
          break;
        }
        case "payments":
          out.push(shareSheet("Payment modes", breakdown!.payments, "Payments"));
          break;
        case "order-types":
          out.push(shareSheet("Order types", breakdown!.orderTypes, "Orders"));
          break;
        case "categories":
          out.push(shareSheet("Categories", breakdown!.categories, "Qty"));
          break;
        case "top-items":
          out.push({
            name: "Top items",
            columns: [{ header: "Item", width: 28 }, { header: "Category", width: 18 }, { header: "Qty", format: "int" }, { header: "Revenue (₹)", format: "money" }],
            rows: breakdown!.topItems.map((i) => [i.itemName, i.category, i.qty, i.revenue]),
          });
          break;
        case "tax":
          out.push({
            name: "GST summary",
            columns: [{ header: "Component", width: 18 }, { header: "Amount (₹)", format: "money" }],
            rows: [
              ["Taxable value", breakdown!.tax.taxableValue],
              ["CGST", breakdown!.tax.cgst],
              ["SGST", breakdown!.tax.sgst],
              ["Total tax", breakdown!.tax.totalTax],
            ],
          });
          break;
        case "day-end": {
          const d = await this.reports.dayEnd(user, outletId, to);
          out.push({
            name: `Day-end ${d.date}`,
            columns: [{ header: "Metric", width: 22 }, { header: "Value", format: "money" }],
            rows: [
              ["Date", d.date],
              ["Orders", d.orders],
              ["Cancelled orders", d.cancelledOrders],
              ["First bill", d.firstBill],
              ["Last bill", d.lastBill],
              ["Gross (₹)", d.gross],
              ["Net (₹)", d.net],
              ["Discounts (₹)", d.discounts],
              ["CGST (₹)", d.cgst],
              ["SGST (₹)", d.sgst],
              ...d.payments.map((p): [string, number] => [`Payments: ${p.label} (₹)`, p.amount]),
              ...d.orderTypes.map((p): [string, number] => [`Order type: ${p.label} (₹)`, p.amount]),
            ],
          });
          break;
        }
        case "fraud": {
          const f = await this.reports.fraud(user, outletId, from, to);
          const cols = [
            { header: "Flag" }, { header: "Bill" }, { header: "Order type" }, { header: "Total (₹)", format: "money" as const },
            { header: "Discount (₹)", format: "money" as const }, { header: "Coupon" }, { header: "Status" }, { header: "Created at", width: 22 },
          ];
          out.push({
            name: "Fraud watch",
            columns: cols,
            rows: [
              ...f.cancelled.map((o) => ["Cancelled", o.billNumber, o.orderType, o.total, o.discountAmount, o.couponCode, o.status, o.createdAt]),
              ...f.discounted.map((o) => ["Discounted", o.billNumber, o.orderType, o.total, o.discountAmount, o.couponCode, o.status, o.createdAt]),
            ],
          });
          break;
        }
        case "cash-sessions": {
          const sessions = await this.cash.recentSessions(user, outletId);
          out.push({
            name: "Cash drawers",
            columns: [
              { header: "Opened at", width: 22 }, { header: "Closed at", width: 22 }, { header: "Status" },
              { header: "Opening float (₹)", format: "money" }, { header: "Cash sales (₹)", format: "money" },
              { header: "Pay-ins (₹)", format: "money" }, { header: "Pay-outs (₹)", format: "money" },
              { header: "Expenses (₹)", format: "money" }, { header: "Refunds (₹)", format: "money" },
              { header: "Expected (₹)", format: "money" }, { header: "Counted (₹)", format: "money" }, { header: "Variance (₹)", format: "money" },
            ],
            rows: sessions.map((s) => [
              s.openedAt, s.closedAt, s.status, s.openingFloat, s.cashSales, s.payIns, s.payOuts, s.expenses, s.refunds, s.expectedCash, s.countedCash, s.variance,
            ]),
          });
          break;
        }
        case "outlets": {
          const k = await this.reports.outletKpis(user, from, to);
          out.push({
            name: "Outlets",
            columns: [{ header: "Outlet", width: 30 }, { header: "Gross sales (₹)", format: "money" }, { header: "Orders", format: "int" }, { header: "AOV (₹)", format: "money" }],
            rows: k.map((r) => [r.outletName, r.grossSales, r.orders, r.avgOrderValue]),
          });
          break;
        }
        default:
          throw new BadRequestException(`Unknown report ${key as string}`);
      }
    }
    return out;
  }

  async customSheet(user: AuthUser, outletId: string, input: CustomReportInput): Promise<Sheet[]> {
    this.assertRange(input.from, input.to);
    const r: CustomReportDto = await this.reports.custom(user, outletId, input);
    const money = r.unit === "currency";
    return [
      {
        name: `By ${r.dimension}`,
        columns: [
          { header: r.dimension, width: 26 },
          { header: money ? `${r.metric} (₹)` : r.metric, format: money ? "money" : "int" },
          { header: "Share", format: "pct" },
        ],
        rows: [...r.rows.map((x) => [x.label, x.value, x.share]), ["Total", r.total, 1]],
      },
    ];
  }

  label(key: ReportExportKey) {
    return LABEL[key];
  }
}
