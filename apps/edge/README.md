# Edge — offline-first POS terminal

The edge app lets a restaurant terminal keep billing when the internet is down. A
local **master service** (Node sidecar + `better-sqlite3`) is the device's source of
truth; orders are created and settled against local SQLite with optimistic writes and
pushed to the cloud API when connectivity returns.

```
 Renderer (offline POS)  ──HTTP──▶  Sidecar master service  ──sync──▶  Cloud API
                                    (SQLite: source of truth)          (Postgres)
```

- `sidecar/engine.js` — the engine: local DB, order lifecycle, sync protocol.
- `sidecar/server.js` — exposes the engine over HTTP + runs the background sync loop.
- `src/` — the Electron/React offline billing renderer.

## Sync model

**Push (device → cloud).** Only **terminal** orders (`SETTLED` / `CANCELLED`) that are
still `dirty` are pushed. Each is keyed by `(deviceId, clientId)` and applied
**insert-once**: the first delivery is applied; any later delivery (a retry, or a
concurrent double-send) is reported as a *duplicate* and ignored. A synced order is
**never overwritten** by a re-sync — this is insert-once, **not** last-write-wins.
When an order applies, the server assigns the authoritative GST bill number and
depletes stock through the normal KOT path, so offline sales reach the KDS and the
stock ledger once synced.

**Pull (cloud → device).** Sync also refreshes the reference snapshot (menu, areas,
prices) from the cloud so the device bills against reasonably current data.

**Numbering.** The device stamps a **provisional** `offlineRef` on the customer's
offline receipt. The authoritative, gapless GST bill number is assigned by the server
from the single per-outlet counter when the order syncs — online and offline sales
share one invoice series (see `apps/api` order settle / `applySyncedOrder`).

**Binding.** A device is bound to exactly one outlet at provisioning
(`EDGE_OUTLET_ID`) and will not silently rebind; see `bootstrap()` in `engine.js`.

## Consistency tradeoffs

Offline-first trades strong consistency for availability. The gaps below are
deliberate and bounded — know them before relying on the device.

### 1. In-flight orders are only as durable as the device

`OPEN` orders are held **locally and are not pushed** until they reach a terminal
state (they are saved non-dirty on purpose). A `SETTLED`/`CANCELLED` order sits in the
local **outbox** (`dirty = 1`) until a sync succeeds. Therefore, if a device is lost,
wiped, or its storage fails:

- **OPEN orders are lost** — an in-progress cart never left the device. This is
  usually acceptable (it is an unfinished order), but staff should settle promptly.
- **Settled-but-unsynced orders are also lost** — revenue that was collected offline
  but had not yet synced does not exist in the cloud. Keep devices reconnecting
  frequently to shrink this window; the background loop drains the outbox every ~10s
  whenever the cloud is reachable.

There is no server-side record of either until sync, so neither can be recovered from
the cloud.

### 2. Stale stock → temporary oversell

Each terminal depletes stock **locally against its last-synced snapshot**. While
offline it cannot see depletion happening on other terminals or in the cloud, and the
cloud cannot see this device's sales until they sync. Consequences:

- Two terminals (or one terminal + online orders) can each sell the "last" unit of a
  low-stock item during an offline window → the item is briefly **oversold**.
- Stock only reconciles when the offline orders sync (the server applies each order's
  depletion then), so the shared count can go **negative** until then.

Mitigation: the snapshot refresh on every sync narrows the drift; manage genuinely
scarce items centrally rather than relying on the edge to hard-block them offline.

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
