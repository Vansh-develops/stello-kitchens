import { HttpException } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasPermission, type AuthUser } from "@stello/shared";
import { PublicApiService } from "./public-api.service";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Local date, YYYY-MM-DD");
const outletId = z.string().optional().describe("Outlet id (see list_outlets). Optional when the key can see one outlet.");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (err) {
    const message = err instanceof HttpException || err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Tool name -> permission it needs; also drives which tools a key can see. */
export const MCP_TOOL_PERMISSIONS: Record<string, string | null> = {
  list_outlets: null,
  list_orders: "orders.view",
  get_order: "orders.view",
  sales_summary: "reports.view",
  top_items: "reports.view",
  list_items: "menu.stock",
  set_item_availability: "menu.stock",
  stock_levels: "inventory.manage",
};

export function buildMcpServer(api: PublicApiService, p: AuthUser): McpServer {
  const server = new McpServer(
    { name: "stello-kitchens", version: "1.0.0" },
    {
      instructions:
        "Stello Kitchens restaurant POS. Amounts are in INR (rupees, 2 decimals). Dates are the outlet's local calendar dates. " +
        "Call list_outlets first when an outletId is needed.",
    },
  );
  const allowed = (tool: string) => {
    const perm = MCP_TOOL_PERMISSIONS[tool];
    return perm === null || hasPermission(p.permissions, perm);
  };

  if (allowed("list_outlets")) {
    server.registerTool(
      "list_outlets",
      { title: "List outlets", description: "Outlets this API key can access.", annotations: { readOnlyHint: true } },
      () => run(() => api.outlets(p)),
    );
  }

  if (allowed("list_orders")) {
    server.registerTool(
      "list_orders",
      {
        title: "List orders",
        description: "Orders newest first, filtered by outlet, status (OPEN | SETTLED | CANCELLED) and date range (default last 7 days). Paginate with nextCursor.",
        inputSchema: {
          outletId,
          status: z.enum(["OPEN", "BILLED", "SETTLED", "CANCELLED"]).optional(),
          from: date.optional(),
          to: date.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => run(() => api.listOrders(p, args)),
    );
  }

  if (allowed("get_order")) {
    server.registerTool(
      "get_order",
      {
        title: "Get order",
        description: "One order with its line items, payments and KOTs.",
        inputSchema: { orderId: z.string() },
        annotations: { readOnlyHint: true },
      },
      (args) => run(() => api.getOrder(p, args.orderId)),
    );
  }

  if (allowed("sales_summary")) {
    server.registerTool(
      "sales_summary",
      {
        title: "Sales summary",
        description: "Gross/net sales, orders, average order value, tax, discounts, new customers and a daily series for a date range (default last 7 days). Settled orders only.",
        inputSchema: { outletId, from: date.optional(), to: date.optional() },
        annotations: { readOnlyHint: true },
      },
      (args) => run(() => api.salesSummary(p, args.outletId, args.from, args.to)),
    );
  }

  if (allowed("top_items")) {
    server.registerTool(
      "top_items",
      {
        title: "Top items",
        description: "Best-selling items by revenue for a date range (default last 7 days), up to 12.",
        inputSchema: { outletId, from: date.optional(), to: date.optional(), limit: z.number().int().min(1).max(12).optional() },
        annotations: { readOnlyHint: true },
      },
      (args) => run(() => api.topItems(p, args.outletId, args.from, args.to, args.limit ?? 10)),
    );
  }

  if (allowed("list_items")) {
    server.registerTool(
      "list_items",
      {
        title: "List menu items",
        description: "Menu items with price and availability (inStock). Optional name search.",
        inputSchema: { outletId, search: z.string().max(80).optional() },
        annotations: { readOnlyHint: true },
      },
      (args) => run(() => api.items(p, args.outletId, args.search)),
    );
  }

  if (allowed("set_item_availability")) {
    server.registerTool(
      "set_item_availability",
      {
        title: "86 / restore an item",
        description: "Mark a menu item out of stock (\"86\" it, inStock=false) or back in stock (inStock=true). Takes effect on POS, KDS and online menus immediately.",
        inputSchema: { outletId, itemId: z.string(), inStock: z.boolean() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      (args) => run(() => api.setAvailability(p, args.outletId, args.itemId, args.inStock)),
    );
  }

  if (allowed("stock_levels")) {
    server.registerTool(
      "stock_levels",
      {
        title: "Stock levels",
        description: "Raw-material stock with reorder levels; set lowOnly to list only materials at or below their reorder level.",
        inputSchema: { outletId, lowOnly: z.boolean().optional() },
        annotations: { readOnlyHint: true },
      },
      (args) => run(() => api.stock(p, args.outletId, args.lowOnly ?? false)),
    );
  }

  return server;
}
