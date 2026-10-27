# Stello Kitchens public API, webhooks and MCP server

This document covers the integration surface for tenants: API keys, the REST public API, outbound webhooks, and the MCP server for AI assistants. All of them are configured in the console under **API & webhooks**, which needs the `integrations.manage` permission.

Base URL: `https://<your-api-host>/api/v1`

## API keys

- Create a key in the console. You choose a name, one or more **permissions** and, optionally, one outlet. The full key (`stk_<id>_<secret>`) is shown **once**. Stello stores only a SHA-256 hash of it, plus the `stk_<id>` prefix so you can recognise the key later.
- A key can only hold permissions that its creator holds. It can never hold the owner wildcard `*`.
- Send the key as `Authorization: Bearer stk_…` or as `X-Api-Key: stk_…`.
- Keys work **only** on the `/ext/*` and `/mcp` routes. Internal console routes refuse them with `403`.
- The console shows each key's **last used** time, updated at most once a minute. Revoking a key takes effect on the next request. Expired keys get `401`.

| Permission | Unlocks |
|---|---|
| `orders.view` | `GET /ext/orders`, `GET /ext/orders/:id`; MCP `list_orders`, `get_order` |
| `reports.view` | `GET /ext/reports/sales-summary`, `GET /ext/reports/top-items`; MCP `sales_summary`, `top_items` |
| `menu.stock` | `GET /ext/items`, `PATCH /ext/items/:id/availability`; MCP `list_items`, `set_item_availability` |
| `inventory.manage` | `GET /ext/stock`; MCP `stock_levels` |

Any credential can call `GET /ext/outlets` and MCP `list_outlets`.

## REST endpoints

Amounts are rupees as decimal numbers. Dates are `YYYY-MM-DD` in the outlet's local calendar. If a key can see exactly one outlet, `outletId` is optional; otherwise it is required.

| Method & path | Query / body | Returns |
|---|---|---|
| `GET /ext/outlets` | none | `[{ id, name, address, gstin }]` |
| `GET /ext/orders` | `outletId?`, `status?` (`OPEN`, `BILLED`, `SETTLED`, `CANCELLED`), `from?`, `to?` (default: last 7 days), `limit?` (1 to 100, default 25), `cursor?` | `{ from, to, items: [...], nextCursor }` |
| `GET /ext/orders/:id` | none | the order with `items`, `payments` and `kots` |
| `GET /ext/reports/sales-summary` | `outletId?`, `from?`, `to?` | gross and net sales, order count, AOV, tax, discounts, new customers, daily series |
| `GET /ext/reports/top-items` | `outletId?`, `from?`, `to?`, `limit?` (up to 12) | `{ from, to, items: [{ itemName, category, qty, revenue }] }` |
| `GET /ext/items` | `outletId?`, `search?` | `[{ id, name, shortCode, category, price, isVeg, inStock }]` |
| `PATCH /ext/items/:id/availability` | body `{ "inStock": false, "outletId"?: "…" }` | `{ id, name, inStock }`. This 86's the item, or restores it, on POS, KDS and online menus straight away. The change is audited. |
| `GET /ext/stock` | `outletId?`, `lowOnly?=true` | `[{ id, name, unit, stockQty, reorderLevel, costPerUnit, lowStock }]` |

**Pagination.** Pass `nextCursor` back as `cursor` to get the next page. When `nextCursor` is `null`, you have reached the last page.

**Errors.** Errors come back as JSON `{ statusCode, message }`:

- `401`: the key is missing, invalid, expired or revoked.
- `403`: the key lacks the permission or the outlet, or the route doesn't accept API keys.
- `404`: the record isn't found within your tenant.

**Rate limit.** Each client IP can make 300 requests per minute across the API.

```bash
curl -H "Authorization: Bearer $STELLO_KEY" \
  "https://api.example.com/api/v1/ext/orders?status=SETTLED&from=2026-10-01&to=2026-10-25"
```

## Webhooks

Subscribe an HTTPS endpoint to one or more events, either for every outlet or for a single outlet. Stello sends a `POST` with a JSON body:

```json
{
  "id": "evt_6f1c…",
  "type": "order.settled",
  "createdAt": "2026-10-26T08:15:02.120Z",
  "tenantId": "…",
  "outletId": "…",
  "data": { "orderId": "…", "order": { "id": "…", "billNumber": "KOR-0042", "status": "SETTLED", "total": 840, "items": [ … ] } }
}
```

| Event | When | `data` |
|---|---|---|
| `order.created` | An order is opened from the POS, scan & order, or an aggregator | `orderId`, `source`, `order` snapshot |
| `order.settled` | An order is paid and closed | `orderId`, `order` snapshot |
| `order.cancelled` | An open order is voided | `orderId`, `order` snapshot |
| `kot.status` | A kitchen station moves a ticket to `PREPARING` or `READY` | `kotId`, `orderId`, `kotNumber`, `stationId`, `status` |
| `item.availability` | An item is 86'd or restored, from any source | `itemId`, `name`, `inStock` |
| `stock.low` | A raw material reaches or drops below its reorder level | `rawMaterialId`, `name`, `unit`, `stockQty`, `reorderLevel` |
| `webhook.test` | You press **Send test** | `message` |

### Headers

- `Stello-Event`: the event type.
- `Stello-Delivery`: the delivery id. It is stable across retries, so use it for idempotency.
- `Stello-Signature: t=<unix seconds>,v1=<hex>`: `v1` is `HMAC-SHA256(secret, "<t>.<raw body>")`.

### Verifying a delivery

The signing secret (`whsec_…`) is shown once, when you create the webhook or rotate its secret. Stello stores it encrypted.

To verify a delivery:

1. Compute the HMAC over the **raw** request body.
2. Compare it to `v1` in constant time.
3. Reject the request if `t` is more than 5 minutes from now.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

### Delivery and retries

- Any `2xx` response within 10 seconds counts as delivered. Redirects are not followed.
- Every other result is retried with exponential backoff and ±10% jitter. The retries come after about **30 s, 2 min, 10 min, 1 h, 6 h and 24 h**, so there are 7 attempts in all. After the last one the delivery is marked `FAILED`.
- Deliveries are stored in the database, so a restart doesn't lose them. Workers claim due deliveries with `FOR UPDATE SKIP LOCKED`, which makes it safe to run several API instances.
- The console shows each delivery's payload, attempts, last status code or error, and duration. You can **redeliver** any delivery that didn't succeed.
- Delivery is at-least-once, so deduplicate on `Stello-Delivery` or on the event `id`.
- The low-stock check remembers what it has already announced in memory. After an API restart, a material that is still low may be announced again.
- In production, webhook URLs must use HTTPS. Targets that resolve to private or loopback addresses are refused (an SSRF guard), unless `WEBHOOK_ALLOW_PRIVATE=true` is set.

## MCP server (for AI assistants)

`POST /api/v1/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server using the Streamable HTTP transport.

- It is **stateless**: there is no session id, and responses are JSON. `GET` and `DELETE` return `405`.
- It is authenticated with an API key. User sessions get `403`.
- The tool list is filtered by the key's permissions.

| Tool | Permission | Purpose |
|---|---|---|
| `list_outlets` | none | Outlets the key can see |
| `list_orders` | `orders.view` | Orders by outlet, status and date range, with pagination |
| `get_order` | `orders.view` | One order with its lines, payments and KOTs |
| `sales_summary` | `reports.view` | Sales KPIs and a daily series |
| `top_items` | `reports.view` | Best sellers by revenue |
| `list_items` | `menu.stock` | Menu items and their availability |
| `set_item_availability` | `menu.stock` | 86 or restore an item |
| `stock_levels` | `inventory.manage` | Raw-material stock, with an optional low-stock-only filter |

There are no reservation tools, because the platform has no reservations module yet.

Example client configuration (Claude Desktop / Claude Code `mcp.json` style):

```json
{
  "mcpServers": {
    "stello": {
      "type": "http",
      "url": "https://api.example.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer stk_XXXXXXXX_…" }
    }
  }
}
```

## Browser sessions (for reference)

The console doesn't use API keys. It signs in with `X-Session-Mode: cookie`, which makes the API set two cookies:

- an httpOnly, `SameSite=Lax` `stello_session` cookie (also `Secure` in production);
- a readable `stello_csrf` cookie.

State-changing requests must echo the CSRF value in `X-CSRF-Token`. The value is bound to the signed session, so a planted cookie can't satisfy the check.

Non-browser clients (the edge device, the connector, scripts) keep using `POST /auth/login` without that header and get a Bearer token in the response body.

`POST /auth/logout` clears the cookies. `POST /auth/logout-all` revokes every session for the user by bumping `tokenVersion`.
