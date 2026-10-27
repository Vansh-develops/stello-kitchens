# Edge — offline-first POS terminal

The edge app lets a restaurant terminal keep billing — dine-in, takeaway and
delivery, with variants, addons, combos, discounts, coupons and split payments —
and keep its kitchen running when the internet is down. A local **master
service** (Node sidecar + `better-sqlite3`) is the device's source of truth.

```
 Renderer (React)  ──HTTP──▶  Sidecar POS API (127.0.0.1:4010)  ──push / pull──▶  Cloud API
                               SQLite: catalog, orders, outbox          /edge/device/* (device token)
 Kitchen tablets ──LAN──▶  Sidecar LAN KDS (0.0.0.0:4011, paired screens, SSE)
```

- `sidecar/engine.js` — local DB + migrations, order lifecycle, invoice series, outbox, change-feed apply, PIN auth, LAN KDS, retention.
- `sidecar/server.js` — POS API (sidecar token + staff PIN session), LAN KDS listener, push/pull loop with backoff.
- `sidecar/kds/index.html` — the self-contained kitchen page served to LAN screens.
- `src/` — the Electron/React renderer (PIN login, floor plan, billing, payments, sync drawer).
- `test/` — `node --test` suites for the engine and the sidecar HTTP surface (`pnpm --filter @stello/edge test`).

## Provisioning

1. In Console › Fleet register a **POS** terminal and copy its id (or device token).
2. Start the terminal with `EDGE_DEVICE_ID=<that id>` (and `EDGE_OUTLET_ID` for a multi-outlet account).
3. On first launch an owner/manager signs in once (needs `edge.activate`). The cloud
   issues a **device token** (stored in SQLite; only its hash is kept server-side) and a
   fresh **invoice series** (`E01`, `E02`, … per outlet), then the terminal pulls the catalog.
   Without `EDGE_DEVICE_ID` the first activation registers a new POS terminal (needs `devices.manage`).
4. Set staff PINs in Console › **Offline POS**. Staff then sign in on the terminal with
   their PIN — online or offline. (Seeded demo: admin `1234`, cashier `1111`.)

| Env var | Default | Purpose |
|---|---|---|
| `MAIN_API_URL` | `http://localhost:3001/api/v1` | Cloud API |
| `EDGE_DEVICE_ID` | — | Provisioned terminal id / deviceToken |
| `EDGE_OUTLET_ID` | — | Outlet to bind to (multi-outlet accounts) |
| `EDGE_PORT` / `EDGE_HOST` | `4010` / `127.0.0.1` | POS API (renderer only) |
| `EDGE_LAN_PORT` / `EDGE_LAN_HOST` | `4011` / `0.0.0.0` | LAN kitchen display; `EDGE_LAN_PORT=0` disables it |
| `EDGE_SYNC_INTERVAL_MS` | `15000` | Push+pull cadence while healthy |
| `EDGE_RETENTION_DAYS` | `30` | Keep synced orders this long |
| `EDGE_DATA_DIR` | `./edge-data` | SQLite location |
| `EDGE_SIDECAR_TOKEN` | dev token | Renderer ↔ sidecar secret (Electron generates one per launch) |

## GST-safe offline bill numbering

Every activation owns its own invoice series. A settled bill gets
`<series>/<FY>/<seq>`, e.g. `E03/2627/000042`:

- `E03` — per-outlet device series, allocated by the cloud at activation. **Re-activation always
  allocates a new series**, so a wiped device that restarts its counter can never reissue a number.
- `2627` — Indian financial year (rolls over on 1 April **IST**), computed from the device clock
  corrected by the skew measured against the cloud.
- `000042` — consecutive within (series, FY). The number is drawn in the same SQLite transaction
  that settles the order and queues it, so numbers are never burnt without a bill.

The format satisfies CGST Rule 46(b): at most 16 characters, only letters/digits/`/`, unique per
financial year, consecutive within each series (the rule allows multiple series). The printed
number **is** the tax invoice; the cloud stores it unchanged as `Order.billNumber` and records it
in `EdgeInvoiceSeq` (unique per device/FY/seq and per outlet/number). Console › Offline POS lists
each series with any **missing numbers** (normally bills still waiting on a terminal that has not
reconnected). The online POS keeps its own `B-n` outlet series. Only if a device presents a number
from a series that isn't its own, or a number already used, does the cloud fall back to the outlet
`B-n` series and file a conflict. Bills settled before a device had a series (legacy outboxes) carry
a provisional reference and are numbered by the cloud on sync.

## Sync model

**Pull (cloud → device).** `GET /edge/device/feed?cursor=N` returns a per-outlet change feed of
settings/tax config, categories (+ kitchen station), items (prices, variants, addons, 86 status),
combos, areas, tables (+ whether the cloud has a running order on them), staff (role,
permissions, PIN hash) and coupons. The feed is *materialised*: each pull recomputes the outlet
catalog, diffs content hashes against `EdgeFeedEntry`, and stamps changes and tombstones with the
next per-outlet sequence, serialised by a row lock — so it catches changes from every code path
without needing `updatedAt` columns. The device applies each page in one SQLite transaction
together with the new cursor. A cursor from the future (server restore) triggers a full reset.

**Push (device → cloud).** Settling or cancelling writes the order and an outbox row in one
transaction. `POST /edge/device/push` takes up to 100 ops in creation order:

- `ORDER` — the full bill as printed (lines with billed unit price and tax rate, payments with
  references, discounts, coupon, invoice number, staff ids, device timestamps, kitchen status).
  Keyed by (terminal, clientId): a retry or a lost acknowledgement comes back `duplicate`.
- `KOT_STATUS` — kitchen progress for an order the cloud already has.

Per op the cloud answers `applied`, `duplicate`, `conflict` (applied, but something needs review),
`rejected` (not applied; stored for review) or `retry` (temporary; the device backs off 5 s → 10 min
with jitter). The background loop runs every 15 s, is nudged within a second of a new sale, and
backs off 5 s → 5 min while the cloud is unreachable. A 401/403 (revoked device, suspended tenant)
stops syncing and shows a re-activation prompt.

**Offline sales are facts.** The customer has paid and holds an invoice, so the cloud records the
sale exactly as billed and files an `EdgeSyncConflict` instead of refusing it:

| Conflict | Meaning |
|---|---|
| `COUPON_LIMIT_EXCEEDED` | A limited coupon was redeemed offline after other terminals had used it up. The discount stands; `usedCount` reflects the real usage (it can exceed the limit). |
| `COUPON_INVALID` / `COUPON_DISCOUNT_MISMATCH` | Coupon expired/inactive at the (corrected) sale time, or the rule now gives a different amount. |
| `PRICE_DRIFT` | Billed at the cached price, which differs from the current menu (also covers items 86'd since). |
| `STAFF_UNKNOWN` / `TABLE_UNKNOWN` | Attribution or table no longer valid; the order is filed without it. |
| `BILL_SERIES_MISMATCH` / `BILL_NUMBER_DUPLICATE` | See numbering above; fallback number assigned. |
| `CLOCK_SKEW` | Device clock was more than 5 min off; sale times were corrected using the measured skew. |
| `REJECTED` | The order's own figures do not add up, or it references catalog rows the outlet never had. Not recorded as a sale — the full payload is kept for a manager. |

Conflicts appear in the terminal's sync drawer (staff can mark them seen) and in Console › Offline
POS (managers resolve them with a note). Offline, coupons are evaluated with the shared rule
engine against the cached coupon and this terminal's own unsynced redemptions; the cross-terminal
usage limit can only be enforced on sync, hence the conflict above.

## Offline staff auth

PIN hashes (scrypt, salted, N=2^14) arrive in the feed; the sidecar verifies them locally. Five
consecutive wrong PINs lock that staff member for 5 minutes, doubling per repeat lockout up to an
hour; lockout state is durable across restarts. Sessions last 12 h and end as soon as the feed
reports the staff member deactivated. Every order carries `createdByStaffId` / `closedByStaffId`;
the cloud stores them as `Order.createdById` and the audit-log actor. Permissions mirror the cloud
(`orders.create`, `orders.settle`, `orders.cancel`). A stolen terminal disk exposes the PIN hashes
of that outlet's staff; a 4–6 digit PIN cannot resist an offline brute force, so revoke the device
and rotate PINs if a terminal is lost.

## LAN kitchen display

The sidecar serves a self-contained kitchen page on `EDGE_LAN_PORT`. From the POS sync drawer a
staff member generates a one-time 6-digit pairing code (10-minute TTL, burned after 5 wrong
guesses, plus a per-IP limit); the screen trades it for a long-lived token (stored hashed, revocable
from the POS). Tickets are per (KOT, station) and stream over SSE. Bumps update the order lines; if
the order has already synced, a `KOT_STATUS` op carries the change to the cloud, so the cloud KDS
doesn't re-show food the LAN kitchen already sent. The LAN listener exposes only the KDS surface,
never the POS API. Traffic is plain HTTP on the shop network.

## Robustness

- SQLite in WAL mode with `synchronous=FULL` (a settled bill survives a power cut).
- Every state change (settle + invoice number + outbox; feed page + cursor) is one transaction.
- Schema migrations are versioned with `PRAGMA user_version`; a pre-migration database is
  upgraded in place and its legacy outbox carried forward.
- Clock skew is measured on every cloud round trip; the fiscal year and coupon validity use the
  corrected clock and the cloud re-corrects sale timestamps.
- Retention: synced orders older than `EDGE_RETENTION_DAYS`, finished outbox rows after 7 days and
  old kitchen tickets are purged every 6 h. Unsynced, rejected and open orders are never purged.

## Known limits

- **Open orders are local.** An order opened on this terminal is pushed only when settled or
  cancelled; until then it lives only on this device and on the LAN KDS (not the cloud KDS). A
  table's bill must be finished on the terminal that opened it. Running orders opened on other
  terminals are visible only as "busy (cloud)" table markers, refreshed on each pull.
- **No terminal-to-terminal LAN sync.** Two edge terminals in one outlet don't talk to each other
  over the LAN; each has its own outbox, series and kitchen screens.
- Loyalty earn/redeem is online-only. Offline cash sales are posted to the open cash-drawer
  session when they sync.
- Card/UPI are recorded, not charged — there is no payment-gateway path offline.
- Stock is not decremented locally; it reconciles when sales sync (it can go briefly negative).
### 3. No cross-device sharing of open orders

An `OPEN` order started on device A cannot be continued or seen on device B — open
orders are never shared. Only terminal orders sync, and only one-way (device → cloud).
A table's bill must be finished on the terminal that started it (until it is settled
and synced).

### 4. Provisional receipt before the tax invoice

A customer paying during an outage gets a receipt showing the provisional `offlineRef`.
The legal GST invoice number is assigned at sync, so it appears in the cloud (and on a
reprinted invoice) only after the device reconnects.

### 5. Reference data lag

Menu, price, and availability changes made in the cloud reach a device only on its
**next snapshot pull**. An offline device bills at its last-synced prices and menu.

## Print agent

Stello runs in the cloud, so the API can never open a socket to a printer on the
restaurant's LAN. The sidecar is the last hop (`sidecar/print-agent.js`):

```
 POS/KDS browser ──HTTP──▶ sidecar /print/* ──TCP 9100 / device──▶ thermal printer
 Cloud print-job queue ◀──claim/complete── sidecar pull loop
```

- **Rendering** uses the shared ESC/POS encoder and KOT/bill renderers
  (`@stello/shared` → `printing/`), the same code the browser path uses for HTML.
- **NETWORK** printers get raw bytes over TCP (port 9100 by default).
- **USB** printers are written as a device path, no native module: `/dev/usb/lp0`
  on Linux, or on Windows share the printer with the *Generic / Text Only* driver
  and set the path to `\localhost\<ShareName>`.
- **Pull loop.** When the sidecar is bootstrapped to an outlet it claims queued
  jobs for that outlet's NETWORK/USB printers every 3 s (atomic server-side claim,
  so several agents/terminals never double print) and reports PRINTED/FAILED.
  This is how KOTs from Scan & Order, aggregators and other terminals reach a LAN
  printer with nobody touching the counter.
- **HTTP.** The dashboard POS probes `GET /print/health` and posts jobs to
  `POST /print/job` (`{ printer, job }`) or raw bytes to `POST /print/raw`. It
  falls back to browser printing when the agent is unreachable.

| Env | Default | Meaning |
| --- | --- | --- |
| `EDGE_PRINT_KEY` | `dev-print-key` (dev only; required in production) | Shared key the POS sends as `X-Print-Key` |
| `EDGE_PRINT_ORIGINS` | `https://kitchens.stellotechs.com,http://localhost:3002` | Dashboard origins allowed to call `/print` |
| `EDGE_PRINT_POLL` | on | `0` disables the cloud pull loop |
| `EDGE_PRINT_PRINTERS` | all NETWORK/USB | Comma-separated printer ids this agent serves |
| `EDGE_PRINT_TZ` | `Asia/Kolkata` | Time zone printed on tickets |

The `/print` routes answer Chrome's Private Network Access preflight
(`Access-Control-Allow-Private-Network`), needed when `https://` dashboard pages
call `http://127.0.0.1`. Newer Chrome versions additionally show a one-time
"local network access" permission prompt for the site — allow it on each POS.

`node apps/edge/print-agent-smoke.mjs` exercises TCP delivery, the device path,
the HTTP endpoint and the pull loop against a fake printer.
