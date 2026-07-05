# Petpooja Clone

A restaurant management platform (Petpooja clone), built as a pnpm monorepo. This
milestone covers **Phase 0 (multi-tenant foundation)**, **core POS billing**, the
**real-time KDS (Kitchen Display System)**, the **admin console** (menu management +
multi-channel pricing), **inventory** (recipes, auto-deduction, costing), the
**aggregator connector** (a standalone service that relays Zomato/Swiggy/ONDC orders
into the POS), **CRM** (customers, loyalty, coupons, campaigns, feedback), and
**reports** (owner analytics: day-end/Z, sales, GST, fraud, cross-outlet KPIs),
**payments + cash management** (dynamic UPI QR, refunds, cash-drawer sessions), and
**GST e-invoicing** (IRN/signed-QR via a GSP, Tally export) — a working counter, kitchen
screen, back-office, online-order pipeline, loyalty program, analytics suite,
cash-drawer workflow, and compliant tax invoicing you can run end to end.

See [`docs/SPEC.md`](docs/SPEC.md) for the full product teardown and phased roadmap.

## What's here

| Package | Stack | Role |
| --- | --- | --- |
| `apps/api` | NestJS + Prisma + PostgreSQL + Socket.IO | Multi-tenant backend: auth/RBAC, menu, orders, KOT, settlement, KDS, channels, inventory, connector, CRM, reports, cash/payments, GST invoicing |
| `apps/pos` | React + Vite | Counter billing screen (web-first) |
| `apps/kds` | React + Vite + socket.io-client | Kitchen Display System (station routing, live tickets) |
| `apps/dashboard` | Next.js | Admin console: menu, combos, channels, pricing, inventory, recipes, prep/production, online orders, customers, marketing, reports (+ custom builder), accounting, central kitchen, Scan & Order, device fleet |
| `apps/connector` | NestJS + BullMQ (Redis) | Standalone aggregator connector: webhooks, adapters, retrying relay |
| `apps/edge` | Node + better-sqlite3 + Electron | Offline-first edge POS: local master service (SQLite source of truth) + sync engine + Electron shell |
| `apps/order` | React + Vite (PWA) | Diner-facing Scan & Order: per-table QR menu, self-service kiosk, token-display board |
| `packages/shared` | TypeScript + Zod | Shared DTO types and request schemas |

### Roles & permissions

Roles hold a permission list (`*` = all). Key permissions: `orders.create`,
`orders.settle`, `orders.cancel`, `kds.operate` (bump tickets), `menu.stock` (86 an
item), `menu.manage` (full menu/channel CRUD), `inventory.manage` (materials, recipes,
receiving, wastage), `crm.manage` (coupons, campaigns, loyalty adjustments),
`devices.manage` (device fleet, owner-only). The
Kitchen role has `menu.stock` but **not** `menu.manage`, so kitchen staff can 86 items
without editing prices; inventory, CRM management, and `reports.view` are owner-only.
Applying a coupon or redeeming points at billing is part of `orders.settle`, so
cashiers can do it.

### Multi-tenancy model

`Tenant → Brand → Outlet → Terminal`. Every table carries `tenantId`; users are
scoped to specific outlets via `UserOutlet`, and every API request is filtered by
the caller's tenant and outlet access. Roles hold a permission list (`*` = all);
permissions like `orders.settle` gate individual endpoints.

## Running it

**Prerequisites:** Node 20+, pnpm, Docker Desktop.

```bash
# 1. Start Postgres + Redis
docker compose up -d

# 2. Install dependencies + build shared types
pnpm install
pnpm --filter @petpooja/shared build

# 3. Create the schema and seed a demo tenant
pnpm --filter @petpooja/api prisma:generate
pnpm --filter @petpooja/api prisma:migrate --name init
pnpm --filter @petpooja/api prisma:seed

# 4. Run each service (one terminal each)
pnpm dev:api        # http://localhost:3001/api/v1
pnpm dev:pos        # http://localhost:5173
pnpm dev:kds        # http://localhost:5174
pnpm dev:dashboard  # http://localhost:3002
pnpm dev:connector  # http://localhost:3003  (needs Redis)
```

Postgres is exposed on host port **5455** and Redis on **6395** to avoid clashing
with any local installs.

### Demo logins

| Email | Password | Role | Outlets |
| --- | --- | --- | --- |
| `admin@demo.com` | `password123` | Owner (all permissions) | Koramangala + Indiranagar |
| `cashier@demo.com` | `password123` | Cashier | Koramangala only |
| `kitchen@demo.com` | `password123` | Kitchen (KDS operate + 86) | Koramangala only |

Only the Koramangala outlet is seeded with a menu, floor plan, and kitchen stations
(Tandoor, Main Kitchen, Beverages, Desserts).

## Using the POS

1. Sign in, pick an outlet (owner sees two; cashier goes straight in).
2. Choose an order type. For **Dine-in**, tap a free table. For **Takeaway/Delivery**,
   optionally enter customer details.
3. Tap menu items to add them. Items with variations or add-ons open a detail dialog;
   simple items add in one tap.
4. **Send KOT** commits the new items to the kitchen and assigns a KOT number. You can
   keep adding items — each batch becomes a new KOT on the same running bill.
5. **Settle** opens the payment dialog: apply a discount, split across cash/card/UPI/wallet,
   and close the bill. A sequential bill number is assigned.

Open tables appear as chips under the search bar; tap one to resume its bill.

## Using the KDS

Sign in at `localhost:5174` as `kitchen@demo.com` (a screen assigned to one outlet
skips the picker). The board is a live wall display:

- **Station tabs** (All / Tandoor / Main Kitchen / Beverages / Desserts) filter the
  board. A KOT that spans stations shows as a separate ticket on each station's screen.
- **Three lanes** — New → Preparing → Ready. Tap a ticket to advance it; tap a Ready
  ticket to recall it. Bumped tickets clear after a few minutes.
- **Ageing colours** — each ticket's timer runs green → amber → red against its
  station's target prep time (Tandoor 12m, Main Kitchen 15m, Beverages 4m, Desserts 5m).
- **Cook list** aggregates item quantities across all active tickets; the **86** button
  marks an item out of stock everywhere (POS and aggregators).

Real-time is driven by a Socket.IO gateway: punching or bumping anything pushes a
`kds:changed` signal to the outlet's room and the board refetches within ~2s (with an
8s poll as a fallback). This is the online path; the offline in-kitchen LAN transport
arrives with the edge client.

## Using the admin console

Sign in at `localhost:3002` as `admin@demo.com` (Owner). Three tabs:

- **Menu** — categories in the sidebar (add / rename / delete); item cards with stock
  toggle, edit, and delete. The item editor covers name, shortcode, category, base
  price, GST, veg/non-veg, **time-based availability** (e.g. 07:00–11:00 for breakfast),
  **variations**, **add-on group** links, and **per-channel pricing**.
- **Add-ons** — create and edit add-on groups (min/max select + priced options).
- **Combos** — build bundled meals (see below).
- **Channels** — manage sales channels (Dine-in / Zomato / Swiggy / …) and their kind.

**Per-channel pricing** is the multi-channel core: for each item you can override the
price per channel (e.g. mark Butter Chicken up to ₹425 on Zomato to absorb commission)
and set an aggregator external item ID, stored in `aggregator_menu_maps` for later
menu push to Zomato/Swiggy. Overrides show as badges on the item card. All writes
require `menu.manage`; edits push a `kds:changed` signal so 86 changes reflect live.

### Combos (bundled meals)

A **combo** (`combos` / `combo_slots` / `combo_slot_options`) bundles items at a fixed
price through **"choose one" slots** — e.g. *Chicken Lover's Meal ₹499* with a Main
(Chicken Biryani, or Butter Chicken +₹20), a Drink, and a Dessert. Each slot has a default
pick and each option can carry a `priceDelta` for an upgrade. The console's **Combos** tab
builds them (slots + options + defaults, GST, veg/non-veg) and 86's them; they surface in
the menu alongside items, grouped by category.

The interesting part is **how a combo is ordered**. When punched it *explodes*:

- one **priced parent line** carries the combo price (with any upgrade deltas) and is
  **billing-only** — it has no KOT and no station, so the kitchen never sees a "combo";
- one **zero-priced component line** per chosen item routes to that item's **station** on a
  KOT and **deducts its own recipe** from inventory.

So *Chicken Lover's Meal* prints one ₹499 line on the bill, but the Biryani, drink, and
dessert each fire to their stations and drop their ingredients from stock. The POS combo
picker, the running-bill nesting (`↳` components under the combo line), and the **diner
Scan & Order** picker all use the same `ComboDto` — a diner can build a combo from their
table QR, and accepting it explodes the same way. Combos are validated online, so the
offline edge doesn't sell them.

## Using inventory & recipes

In the console (`admin@demo.com`), two more tabs:

- **Inventory** — raw materials with on-hand stock, reorder levels, weighted-average
  cost, and stock value. Add materials, **receive** stock (blends cost at a weighted
  average), record **wastage**, and manage vendors. Materials at or below their reorder
  level are flagged, with a "reorder needed" banner and a low-stock count.
- **Recipes** — every dish with its computed **food cost** and **margin** (colour-coded).
  Open a recipe to map raw materials and quantities per plate; margin updates live.

**Auto-deduction is the core loop**: when a KOT is punched (from the POS), each item's
recipe is deducted from stock inside the same transaction and written to an append-only
`stock_movements` ledger. Order a Butter Chicken and its chicken/cream/spices drop from
inventory automatically; the 7-day consumption report and costing reflect it. Receiving
raises stock; wastage lowers it. `raw_materials.stockQty` is the denormalised running
balance over the ledger.

### Multi-stage recipes (semi-finished goods)

Some materials are **produced in-house** rather than bought — a *Makhani Gravy Base* made
from onion, tomato, butter, cream, and spice. A `RawMaterial` flagged `isSemiFinished` has
a **prep recipe** (`prep_recipe_ingredients`: input material × quantity per output unit).
The console's **Prep** tab defines these and **produces batches**: producing 5 L of gravy
base consumes 1.5 kg onion, 2 kg tomato, etc. (each a `PRODUCTION_OUT` movement) and yields
5 L of base (`PRODUCTION_IN`) at a **weighted-average cost** blended across batches.

Dishes then consume the base like any other material — *Butter Chicken*'s recipe is
`chicken + Makhani Gravy Base + spice`, so selling it draws down the base, and prepping the
base draws down its raw inputs. This is standard **batch production**: intermediates are
tracked as their own stock, not exploded to raw materials at sale time. A batch is blocked
if any input is short.

## Central kitchen / commissary (`apps/api/src/central-kitchen`)

An outlet flagged `isCentralKitchen` becomes the commissary; every other outlet in the
brand is treated as its satellite. The console's **Central kitchen** tab is role-aware:
a satellite sees a *raise-an-indent* form (pick materials from the commissary's stock,
enter quantities) plus its own indent history; the commissary sees **incoming indents**
with dispatch and e-way-bill actions.

The flow is `DRAFT → DISPATCHED → RECEIVED` (or `CANCELLED`):

1. A satellite **raises an indent** (`indents` + `indent_items`) for raw materials.
2. The commissary **dispatches** it — stock is decremented at the commissary and a
   `TRANSFER_OUT` movement is written to the same append-only ledger inventory uses.
3. The commissary **generates an e-way bill** (`eway_bills`): a 12-digit EWB number,
   consignment value (`Σ dispatchedQty × unitCost`), both GSTINs, and a validity window
   derived from the road distance (1 day per 200 km, per GST rules).
4. The satellite **receives** the goods — the material is found or created locally by
   name and stock is incremented with a matching `TRANSFER_IN` movement.

All actions are gated behind `inventory.manage`, so a cashier is blocked (403).

## Aggregator connector (`apps/connector`)

A **separate deployable** (port 3003) that owns the aggregator relationship — the spec
treats it as its own service with its own uptime budget. Real Zomato/Swiggy access is
onboarding-gated, so this is a faithful simulation of the documented flow:

1. Each provider POSTs its order shape to `POST /webhooks/:platform/order`. A
   **platform adapter** (Zomato full; Swiggy/ONDC/UrbanPiper functional stubs) parses
   it to a canonical order.
2. The webhook **ACKs fast (202)** and enqueues to **BullMQ** (Redis) — a main-API blip
   becomes a retry with backoff, not a lost order.
3. The worker forwards to the main API's service-authenticated `POST /connector/ingest`
   (shared-secret `x-connector-key`), which **maps external item IDs → internal items**
   via `aggregator_menu_maps`, creates a DELIVERY order through the normal order path
   (so it hits the KDS and **deducts inventory**), and persists an `AggregatorOrder`.
4. Re-delivered webhooks are **idempotent** (unique `platform + externalOrderId`).
   Unmapped external items are recorded, not silently dropped.
5. `POST /push/:platform/menu|stock` pulls the push payload (mapped items, per-channel
   prices, out-of-stock IDs) from the main API and simulates the provider send.

The console's **Online orders** tab shows relayed orders + platform reconciliation.
The Swiggy/ONDC/UrbanPiper adapters and the outbound provider calls are stubs pending
onboarding credentials; the ONDC ed25519 signing and Beckn registry lookups are noted
in-code as onboarding concerns.

## CRM: customers, loyalty, coupons, campaigns, feedback

- **Customers** are created automatically when an order is settled with a phone number.
  Each carries order count, spend, last visit, and a computed **segment** (New / Regular /
  VIP / Lapsed). The console's **Customers** tab lists them with segment counts; a detail
  view shows the loyalty ledger, order history, and a manual top-up/adjust control.
- **Loyalty** earns points on settlement (`round(total × outlet.loyaltyEarnRate)`), with
  a full transaction ledger. At billing, the POS settle dialog looks up the customer by
  phone and lets the cashier **redeem points** (1 point = `outlet.loyaltyPointValue` rupees)
  as a discount — verified live in the POS.
- **Coupons** (FLAT / PERCENT, min-order, max-discount, validity, usage limits) are managed
  in the **Marketing** tab and applied at billing via a shared, pure rule engine
  ([`packages/shared/src/coupon.ts`](packages/shared/src/coupon.ts)) so the settle path and
  the dashboard preview agree.
- **Campaigns** target a segment over SMS / WhatsApp / Email through a
  `NotificationProvider` abstraction (a logging stand-in for MSG91 / Gupshup — swap the
  binding for a real client at integration time).
- **Feedback** is submitted to a public, unauthenticated endpoint (`POST /public/feedback/:outletId`,
  reached from a QR-on-bill / SMS link) and listed with an average rating in Marketing.

**Redeeming points is OTP-gated** (`apps/api/src/loyalty`). At billing, the cashier requests
an OTP (`POST /outlets/:id/loyalty/request-otp`) that's "sent" to the customer's phone via
the `NotificationProvider`; the customer reads it back, and the cashier enters it. The
settle path verifies + **consumes** the code inside the settlement transaction, so a wrong
or expired OTP rolls back the whole bill and a code is strictly single-use. The POS settle
dialog shows the **Send OTP** button and OTP field only once points are being redeemed.

## Reports (owner analytics)

The console's **Reports** tab (owner-only, `reports.view`) computes from the settled
transactional data over a Today / 7-day / 30-day range:

- **Cross-outlet KPIs** and headline cards: gross/net sales, orders, AOV, tax collected,
  discounts, new customers, plus a daily sales bar chart.
- **Breakdowns** with share bars: payment modes, order types, categories; a top-items
  table; and a **GST summary** (taxable value + CGST/SGST).
- **Day-end (Z) report**: order count, bill-number range, gross, tax, discounts,
  cancellations, and the payment split for a single day.
- **Fraud & pilferage watch**: cancelled and discounted orders (with the coupon that
  drove each discount), and the total value given away.

- **Custom report builder**: pick a **dimension** (item, category, order type, payment
  mode, hour of day, or day) and a **measure** (revenue, orders, or quantity) and get a
  ranked, bar-charted breakdown over the selected range — grouping settled sales on demand
  (`POST /outlets/:id/reports/custom`).

Reports are computed on-the-fly with Prisma aggregations. For high volume the spec calls
for BullMQ precompute + materialized views — noted as a scale optimization, not needed at
this data size.

## Payments & cash management

- **Payment gateway** is behind a `PaymentGateway` interface with a **mock Razorpay**
  ([`apps/api/src/payments/payment.gateway.ts`](apps/api/src/payments/payment.gateway.ts)).
  Swap the binding for a real client at integration time; only the capture webhook and
  settlement are stubbed.
- **Dynamic UPI QR at billing**: the POS settle dialog can render a **real, scannable**
  `upi://pay?...` deep link for the current payable, built from the outlet's VPA — a
  phone's UPI app opens it. Split payments across cash/card/UPI/wallet already exist.
- **Refunds** against a settled order go through the gateway (non-cash) and are persisted;
  a cash refund leaves the open drawer. Refunds require `orders.cancel` (manager).
- **Cash drawer**: the POS rail has an **open/close drawer** widget. Opening records a
  float; each cash-settled bill auto-posts a `SALE` movement to the open session; pay-outs
  and **categorised expenses** reduce it; closing counts the cash and shows the
  **variance** vs expected. The dashboard **Reports → Cash drawers** table lists sessions
  with expected/counted/variance. Cash ops require `orders.settle` (cashiers included).

## GST e-invoicing & accounting

The **Accounting** tab (owner-only, `finance.manage`) treats each settled order as a tax
invoice:

- **Invoice detail** shows the seller GSTIN, place of supply, and an **HSN/SAC summary**
  (grouped by HSN + rate, with the order discount spread proportionally) that reconciles
  to the CGST/SGST totals.
- **E-invoicing**: "Generate IRN" submits to the IRP **through a GSP behind an
  `EInvoiceProvider` interface** (mock — [`apps/api/src/invoices/einvoice.provider.ts`](apps/api/src/invoices/einvoice.provider.ts))
  and stores the returned **IRN**, **signed QR** (rendered as a scannable code),
  ack number and date. E-invoices are **immutable** — re-generation is rejected; a real
  correction is a credit note. **We never build GSTN plumbing** — the GSP is the seam.
- **Tally export**: downloads a Tally-importable **XML** of ledger-mapped sales vouchers
  (party debit; Sales / Output CGST / Output SGST credits) for a date range.

E-way bills are generated on the central-kitchen goods movement (see the Central kitchen
section above), not on customer invoices.

## Offline-first edge client (`apps/edge`)

The genuinely new muscle from the spec: a terminal that keeps billing with the WAN down,
built as the spec's **"local master service"** so no native module ever runs inside
Electron (the usual Windows failure point).

- **Local master service (sidecar)** — a Node process owning a **better-sqlite3** database
  that is the device's *source of truth*. It exposes a small HTTP API on `localhost:4010`
  and runs a background sync loop.
- **Optimistic local writes** — orders are created and settled in local SQLite and get a
  device-prefixed **offline bill number** (`<device>-<seq>`). They sit in an **outbox**
  (`dirty` rows) until they can be pushed.
- **Sync protocol** against the cloud API: `GET /sync/snapshot` caches menu + tables so the
  device can bill offline; `POST /sync/push` drains the outbox — **idempotent by
  `(deviceId, clientId)`**, so re-pushes never duplicate — and the cloud applies each order
  through the normal path, so **offline sales deduct inventory and reach the KDS/reports**
  once synced; `GET /sync/pull?since=` fetches deltas for cross-terminal awareness. Conflict
  policy is **last-write-wins by `clientUpdatedAt`**; cancels are tombstones.
- **Electron shell + renderer** — the shell spawns the sidecar and loads an offline POS UI
  (menu → cart → settle) with a live **ONLINE/OFFLINE** indicator, **outbox count**, and
  **Sync now**. The renderer talks only to the sidecar, so it behaves identically on- and
  offline.

Run it: `pnpm edge:sidecar` + `pnpm edge:renderer` (open `localhost:5175`), or
`pnpm edge:electron` for the desktop shell. Multi-terminal LAN coordination (several
terminals against one master) and a full delta protocol for reference data are the next
steps; today reference data is a full snapshot and each terminal runs its own master.

## Scan & Order — first-party online ordering (`apps/order`)

A diner-facing PWA plus a staff validation queue. Everything the diner touches is keyed by
an **opaque public token** (per-table for dine-in, per-outlet for kiosk / board), so there
is no tenant or outlet id to enumerate — a bad token simply 404s. All diner endpoints are
`@Public` (no auth).

**The flow — validate before firing.** A diner scans the QR on their table, browses the
menu, configures variations/add-ons, and submits a cart. That does **not** fire a KOT: it
creates an `OrderRequest` in `PENDING`. Staff see it in the console's **Scan & Order** tab
and **Accept** (→ fires a KOT through the same trusted punch path aggregator orders use, so
inventory deducts and it reaches the KDS; for dine-in it appends to the table's running
order) or **Reject**. This keeps stray/prank orders out of the kitchen. The diner's phone
polls its request token and flips to a **token number** on acceptance.

- **`/t/:token`** — per-table Scan & Order (dine-in). Includes a **Call a server** button
  (the wireless calling-device concept).
- **`/kiosk/:token`** — self-service **takeaway** kiosk mode.
- **`/board/:token`** — the customer-facing **token-display** board (a counter TV): accepted
  tokens sit under *Preparing* and move to *Ready to collect* as the KDS marks items ready.

The console's **Scan & Order** tab is a live validation queue (accept/reject) plus a **QR
codes** view that renders real, scannable QR codes for every table, the kiosk, and the board
(printable onto tent cards).

**Hardware add-ons** (`apps/api/src/hardware`) sit behind a `HardwareBridge` seam with a
**mock** implementation — the same interface a real serial/USB/HID driver would implement,
like the payment gateway: a **weighing scale** reading (for by-weight items), a **caller-ID**
pop that resolves the ringing number to a customer, and the diner-side **call-a-server**
pager. Real device drivers are the integration seam and are not built.

Run it: `pnpm order` (open `localhost:5176/t/<tableToken>`); table/outlet tokens are seeded
and printable from the dashboard's Scan & Order → QR codes view.

## Device fleet management (`apps/api/src/devices`)

The console's **Fleet** tab (owner-only, `devices.manage`) registers and configures every
device in an outlet — POS counters, KDS screens, receipt printers, kiosks, displays (the
`terminals` table gained a `type`, a JSON `config`, and an `isActive` flag). Each device
type has its own settings form: a **printer** carries paper width (58/80mm), auto-print
KOT/bill toggles, and copies; a **KDS** carries theme, density, columns, and alert sound.

Devices **self-report liveness** by posting their token to `POST /public/devices/heartbeat`,
which stamps `lastSeenAt` and drives the online/offline dot (a **Ping** action simulates it
from the dashboard). A **config backup** (`GET .../devices/backup`) exports a JSON snapshot
of the outlet — menu by category, tables, the fleet and its settings, and counts — that the
dashboard downloads as a file. Real silent-printing drivers and KDS theme application live
on the devices themselves; this is the management + config-distribution layer.

## API surface (v1)

```
POST /auth/login              GET /auth/me
GET  /outlets                 GET /outlets/:id/tables
GET  /outlets/:id/menu        PATCH /outlets/:id/menu/items/:itemId/stock   (menu.stock)
POST /orders                  GET /orders?outletId=   GET /orders/:id
POST /orders/:id/items        POST /orders/:id/settle POST /orders/:id/cancel
GET  /outlets/:id/kds/stations   GET /outlets/:id/kds/tickets   GET /outlets/:id/kds/stock
POST /kds/kots/:kotId/advance    (WS: join { outletId } → kds:changed)

# Menu management (all require menu.manage)
GET    /outlets/:id/menu/admin
POST   /outlets/:id/menu/categories        PATCH|DELETE .../categories/:id
POST   /outlets/:id/menu/items             PATCH|DELETE .../items/:id
POST   /outlets/:id/menu/addon-groups      PATCH|DELETE .../addon-groups/:id
POST   /outlets/:id/channels               PATCH|DELETE .../channels/:id
GET    /outlets/:id/combos                 POST .../combos   PATCH|DELETE .../combos/:id
PATCH  /outlets/:id/combos/:id/stock       (menu.stock — 86 a combo)
GET    /outlets/:id/inventory/materials/:id/prep-recipe   PUT ... (inventory.manage)
POST   /outlets/:id/inventory/materials/:id/produce       ({ quantity } — batch production)

# Inventory (reads open to outlet; writes require inventory.manage)
GET    /outlets/:id/inventory/materials    POST .../materials   PATCH|DELETE .../materials/:id
POST   /outlets/:id/inventory/materials/:id/receive   POST .../:id/wastage
GET    /outlets/:id/inventory/vendors      POST/DELETE .../vendors[/:id]
GET    /outlets/:id/menu/items/:itemId/recipe         PUT (set recipe)
GET    /outlets/:id/inventory/costing      GET .../consumption?days=   GET .../movements

# Connector — service-auth (x-connector-key) unless noted
POST   /connector/ingest                   POST /connector/orders/:platform/:extId/status
GET    /connector/menu-push/:platform       GET /connector/stock/:platform
GET    /outlets/:id/aggregator/orders  (JWT)   GET /outlets/:id/aggregator/reconciliation  (JWT)
# Connector service (port 3003):
POST   /webhooks/:platform/order   POST /push/:platform/menu|stock   GET /health

# CRM (reads open to outlet; writes require crm.manage)
GET    /outlets/:id/customers            GET .../customers/summary   GET .../customers/by-phone?phone=
GET    /outlets/:id/customers/:id        POST .../customers/:id/loyalty
GET    /outlets/:id/coupons              POST/PATCH/DELETE .../coupons[/:id]   GET .../coupons/preview
GET    /outlets/:id/campaigns            POST .../campaigns   POST .../campaigns/:id/send
GET    /outlets/:id/feedback             POST /public/feedback/:outletId  (public)
POST   /outlets/:id/loyalty/request-otp  ({ phone } — OTP for points redemption at settle)

# Reports (require reports.view)
GET    /outlets/:id/reports/overview?from=&to=    GET .../reports/breakdown?from=&to=
GET    /outlets/:id/reports/day-end?date=         GET .../reports/fraud?from=&to=
POST   /outlets/:id/reports/custom   ({ from, to, dimension, metric })
GET    /reports/outlets?from=&to=   (cross-outlet KPIs)

# Device fleet (require devices.manage; heartbeat is public)
GET    /outlets/:id/devices                 POST .../devices   PATCH|DELETE .../devices/:id
GET    /outlets/:id/devices/backup          POST /public/devices/heartbeat ({ deviceToken })

# Cash & payments (require orders.settle; refund requires orders.cancel)
GET    /outlets/:id/cash/current           POST .../cash/open   POST .../cash/close
POST   /outlets/:id/cash/movement          GET  .../cash/sessions[/:id]
POST   /outlets/:id/payments/:orderId/upi-qr    POST .../payments/:orderId/refund

# Accounting / GST (require finance.manage)
GET    /outlets/:id/invoices?from=&to=      GET .../invoices/:orderId
POST   /outlets/:id/invoices/:orderId/irn   POST .../invoices/:orderId/cancel-irn
GET    /outlets/:id/exports/tally?from=&to=

# Central kitchen / commissary (require inventory.manage)
GET    /outlets/:id/central-kitchen/context     GET .../central-kitchen/indents
POST   /outlets/:id/central-kitchen/indents     (satellite raises an indent)
POST   .../central-kitchen/indents/:id/dispatch   POST .../indents/:id/receive
POST   .../central-kitchen/indents/:id/eway-bill  ({ distanceKm })

# Scan & Order — diner-facing (all @Public, keyed by opaque token)
GET    /public/scan/t/:token          GET /public/scan/kiosk/:token
POST   /public/scan/t/:token/order    POST /public/scan/kiosk/:token/order
GET    /public/scan/request/:token    GET /public/scan/board/:token
POST   /public/scan/t/:token/call-waiter

# Scan & Order — staff validation (require orders.create)
GET    /outlets/:id/scan-requests            GET .../scan-requests/table-qrs
GET    /outlets/:id/scan-requests/public-token
POST   /outlets/:id/scan-requests/:id/accept POST .../scan-requests/:id/reject

# Hardware bridge — mock (require orders.create)
GET    /outlets/:id/hardware/scale     GET /outlets/:id/hardware/caller-id

# Offline sync (edge device ↔ cloud)
GET    /sync/snapshot?outletId=      GET /sync/pull?outletId=&since=
POST   /sync/push   (orders.create; idempotent by device+client id)
```

## Not yet built (see SPEC.md roadmap)

Full Swiggy/ONDC aggregator
integration (adapters are stubs),
live payment-gateway and GSP credentials (both are mocks), and
multi-terminal LAN coordination for the edge client (each terminal currently runs its own
master service). The schema and DTOs are shaped to grow into these without a rewrite.
