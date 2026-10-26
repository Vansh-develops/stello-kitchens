# Evidence index and reproduction notes

Audit date: 21 September 2026. Product source was not modified. Existing working-tree changes were preserved. The two reports are [commercial readiness](COMMERCIAL-READINESS-AUDIT.md) and [market/roadmap](MARKET-AND-ROADMAP.md).

## Environment

- Workspace: `C:\Projects\Pet Pooja Clone`; baseline HEAD `141e65867e932e1da83ec50d20314fc0e171c580`, plus pre-existing local changes.
- Local shell: Windows PowerShell; Node 23.1.0. Package manager invoked as `npx.cmd --yes pnpm@10.33.2` because the installed Corepack path failed signature validation.
- Deployment Dockerfile uses Node 24. The connector idempotency smoke was additionally run with Node 24.21.0 and exited successfully.
- Disposable PostgreSQL 16 container bound only to `127.0.0.1:15455`; disposable Redis 7 bound to `127.0.0.1:16395`.
- Isolated API: port 13001, database `stello`. Separate smoke API: port 13011, database `stello_smoke`. Normal tests: database `stello_test`.
- Local dashboard: port 13002, API/socket origins explicitly pointed to 13001. Connector: port 13003, pointed to the smoke API/Redis for smoke checks.
- No production mutation, load test or payment action was executed. The advertised live demo login was attempted once and rejected.
- Cleanup completed: stopped the audit API, smoke API, dashboard and connector processes, and both disposable audit containers. Their temporary databases were intentionally disposable; saved scripts/results remain in this folder. The pre-existing application on port 3001 was not stopped.

## Result files

| File | Purpose |
|---|---|
| `typecheck.log`, `build.log`, `test.log` | Standard commands and results; 58 normal tests passed |
| `migrations.log`, `seed.log` | Clean local database initialization |
| `api-audit.cjs` / `api-results.json` | 19 assertions: 12 pass, 7 fail; money, tenancy, KDS, QR, sync and tax |
| `extended-audit.cjs` / `extended-results.json` | 9 assertions: 4 pass, 5 fail; sessions, sockets, suspension, sync and offline engine |
| `stock-connector-audit.cjs` / `stock-connector-results.json` | 3 assertions, all fail; stock concurrency, modifiers, connector authentication |
| `local-load-check.cjs` / `local-load-results.json` | 50 workflows, five workers; 49 completed and one 500 |
| `local-api.log` | Includes the load sample's Prisma P2028 transaction acquisition timeout |
| `live-check.cjs` / `live-results.json` | Read-only public deployment health, status and response headers |
| `dependency-audit.json`, `licenses.json` | Production dependency vulnerability and license inventory snapshots |
| `run-smokes.cjs`, `smoke-results.json`, individual smoke logs | Initial broader smoke run; read corrections below before interpreting totals |
| `smoke-local-preload.mjs` | Redirects hardcoded localhost smoke URLs to isolated services and blocks other HTTP destinations |

These scripts are diagnostic, fixture-mutating tools, **not production-safe probes**. Read their source and prerequisites before re-running. They create orders/payments/refunds and can alter fixture prices, users and inventory. Use only a disposable database and the explicit local ports above. A nonzero failure count represents a failed product invariant, not necessarily a process exit failure; inspect JSON results.

## Smoke suite corrections and final accounting

The initial run is preserved verbatim. One preparation-cost assertion failed because an earlier combo smoke left a stock balance at -0.15. One connector idempotency script exited zero while silently skipping its checks because its recipe/mapping fixture was missing. These demonstrate test-harness limitations and should be repaired in CI: isolated fixtures, explicit skipped counts and failure when required setup is missing.

`prepare-smoke-rechecks.cjs` repaired only the disposable fixtures. `prep-isolated-recheck.log` then records 17 passes. The connector rerun executed all nine assertions successfully but Node 23 exited with a Windows libuv handle assertion. Repeating on Node 24.21.0 produced nine passes and exit zero: `connector-node24-recheck.log` and `connector-node24-exit.txt`.

Final assertion totals, taking those corrected runs rather than double-counting reruns:

| Smoke | Passed assertions |
|---|---:|
| API combo | 21 |
| API connector idempotency | 9 |
| API core | 19 |
| API custom reports | 12 |
| API fleet | 16 |
| API IGST | 9 |
| API invoice series | 8 |
| API loyalty atomicity | 8 |
| API loyalty OTP | 11 |
| API preparation | 17 |
| API scan combos | 13 |
| API scan ordering | 29 |
| API sync idempotency | 9 |
| API tenancy | 7 |
| Edge device binding | 7 |
| Edge money parity | 7 |
| Edge theme cache | 4 |
| Connector webhook signatures | 12 |
| **Total** | **218** |

These include simulated providers and development webhook payloads. Passing IGST checks reflects the current implementation's expectation, not statutory correctness. A mock IRN is not an authentic GSP acknowledgement. The new concurrency/security assertions deliberately cover invariants that these smoke scripts miss.

## Local backup/restore observation

Within the disposable PostgreSQL container, executed `pg_dump -U stello -d stello -Fc`, created `stello_audit_restore`, and restored with `pg_restore --exit-on-error`. Querying order counts returned 234 in both databases at that point in the audit. This confirms a basic local dump is restorable. It does not verify the repository backup script's scheduling, encryption, off-site retention, all-table equivalence or production recovery time/point objectives. This note records the tool-observed result; no separate restore transcript was saved.

## Reproduction approach

1. Use a disposable PostgreSQL/Redis instance, initialize with the actual migrations and seed, and set explicit local-only `DATABASE_URL`, `DATABASE_URL_TEST`, JWT and connector test secrets.
2. Build and start the API on the ports expected by the scripts. Normal commands were `pnpm typecheck`, `pnpm build` and `pnpm test`, invoked through the pinned npx package manager described above.
3. Inspect and run the diagnostic `.cjs` scripts sequentially. They depend on seeded menu/outlet fixtures and some directly use Prisma/native SQLite; they are not a standalone portable test package.
4. Run the existing smoke scripts through `run-smokes.cjs`, using its isolated URL preload. Establish the required stock and connector fixtures before treating absence of failures as a pass.
5. Compare the saved JSON and database invariants, not only HTTP success codes. Promote each confirmed defect into an isolated regression test during remediation.

For settlement and stock race reproduction, the scripts intentionally hold a database row lock briefly to align concurrent requests. For sync pagination, 205 rows intentionally share one timestamp. These controlled fixtures establish correctness defects; they do not measure their frequency in customer traffic.

## Handling these artifacts

Logs and JSON contain local fixture identifiers and synthetic transactions. Treat the audit folder as internal engineering evidence and review it before external distribution. Do not publish runtime databases or operational secrets. The reports distinguish public vendor sources from application evidence and local findings from live observations.
