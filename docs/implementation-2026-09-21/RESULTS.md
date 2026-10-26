# Transaction-integrity implementation: batch 1

Date: 21 September 2026. Follow-up to the [audit](../audit-2026-09-21/COMMERCIAL-READINESS-AUDIT.md) and [implementation plan](../IMPLEMENTATION-PLAN.md). Changes are local and have not been deployed.

## Implemented behavior

| Audit finding | Change | Regression evidence |
|---|---|---|
| A01 duplicate settlement | Lock the owned order before checking state, calculating discount/totals or writing payment/bill/loyalty. Cancellation and item additions use the same order lock. Payments must match exactly in paise. | 20 competing settlements produce one successful settlement, one payment, one bill-counter increment and one loyalty effect; cancellation/addition races and underpayment rollback are covered. |
| A02 excessive refunds | Lock the order and reserve aggregate refundable balance, capped by order value and recorded payments. Cash refund and drawer movement share one transaction. Optional operation keys deduplicate retries. | Partial/full/concurrent refunds, changed-key payload rejection, invalid amounts, cross-tenant access and forced cash-movement failure are covered. |
| A03 foreign table | Validate tenant and outlet in the table-lock query for staff, scan and offline ingestion. Also scope item/combo/component queries and validate modifier-group ownership. | Foreign tenant and foreign outlet table references are rejected with no order/KOT created. This addresses the demonstrated path, not a complete tenancy certification. |
| A06 lost receipts | Lock the material before reading quantity/cost and committing receipt plus movement. Wastage uses the same lock and atomic decrement. Validate receiving vendor ownership. | Two receipts preserve quantity and weighted value; receiving versus wastage preserves all movements; foreign vendors are rejected. |
| A07 duplicate table occupancy | Hold the table lock across the open-order check and creation; scan ingestion rechecks a running order after locking it. Preserve offline dine-in retry deduplication. | Staff/staff and staff/scan contention plus offline retry compatibility are covered. |
| A15 modifiers | Reject duplicate IDs, enforce group minimum/maximum selection and constrain ownership before committing the order. | Invalid combinations roll back and valid selections produce the expected total. |

Tests live in `apps/api/test/transaction-integrity.test.ts` and run with the ordinary API test suite. The existing CI/test workflow therefore picks them up without a separate audit-script invocation.

## Refund contract and migration

Apply `20260921030000_refund_reservations` before starting the changed API. It adds nullable `requestKey`, a unique per-order operation-key index, a lookup index and `status`. Existing refund records retain the historical interpretation `PROCESSED`; this does not retroactively verify a real provider transaction.

For `POST /api/v1/outlets/:outletId/payments/:orderId/refund`, clients should generate one stable `requestKey` per user-confirmed operation and reuse it after a network failure:

```json
{"amount":25,"mode":"CASH","reason":"Returned item","requestKey":"one-stable-operation-uuid"}
```

Responses include `id`, `gatewayRef` and `status`:

- `PROCESSED`: cash bookkeeping committed, or the configured provider reported processed. The current provider is still a mock; this is not evidence of real electronic funds movement.
- `PENDING`: balance reserved while provider completion is unresolved.
- `UNKNOWN`: provider call/result persistence failed; do not refund that balance again without reconciliation.

Pending/unknown amounts continue consuming refundable balance. API retries with the same key return the stored reservation and do not resubmit the provider call. Different details with the same key are rejected. Legacy requests without keys remain accepted and cumulative limits still apply, but a partial refund retry without a key cannot be distinguished from another intended partial refund. Updating every refund client to retain keys is a follow-up requirement.

The provider interface now receives the persisted refund ID as its idempotency key. Provider calls happen after reservation commit, outside row-lock transactions. A crash before provider dispatch deliberately leaves a pending reservation. A recovery worker, signed provider events and an operator reconciliation interface are still required in the integration phase; this batch does not automatically release or retry uncertain money movements.

## Validation

- All six workspaces passed type checking: [typecheck.log](typecheck.log).
- Actual migrations, including the new migration, applied successfully to a clean disposable PostgreSQL database: [migrations.log](migrations.log).
- Initial corrected targeted run: 17/17 tests passed, including the 20-caller settlement race: [transaction-tests.log](transaction-tests.log).
- The expanded regression file passed all 18 tests in the full-suite run, including offline dine-in retry compatibility: [full-tests.log](full-tests.log).
- All six production workspace builds passed: [build.log](build.log). The final API type check also passed after the compatibility adjustment: [api-final-typecheck.log](api-final-typecheck.log).
- Batch 2 final checks: all six workspace type checks and builds passed; the fresh-database full suite passed 76 tests again: [batch 2 tests](full-tests-batch2.log), [batch 2 typecheck](typecheck-batch2.log), [batch 2 build](build-batch2.log).
- Connector push routes now require `x-connector-key`; connector typecheck/build passed after this change. The earlier unauthenticated local connector finding is fixed in source, but an internet-facing deployment should still keep port 3003 private.
- Dashboard responses now declare CSP, frame, referrer, content-type and permissions headers; the dashboard production build passed after the configuration change.
- Final standard suite: **76 tests passed** (23 shared and 53 API, including all 18 new regressions), zero failures: [full-tests.log](full-tests.log). API tests completed in 286.73 seconds.

An earlier test-development run used an actor missing from the users table and failed on the audit-log foreign key. The fixture was corrected to create a real test user/role; application constraints were preserved. All destructive setup and trigger-based failure injection used disposable local PostgreSQL on port 15455. No production database was used.

Validation runtime: local Windows, Node 23.1.0, pnpm 10.33.2 and PostgreSQL 16 in Docker. Production uses Node 24/Linux; its load/soak and provider/hardware validation remain separate gates. Commands used the explicit disposable `DATABASE_URL_TEST` with `pnpm test`, `pnpm typecheck`, `pnpm build`, and the disposable `DATABASE_URL` with `prisma migrate deploy`.

Source diff whitespace checks and report link checks passed. Pre-existing working-tree changes were preserved. No commit or deployment was made.

## Remaining gates and rollout limits

This is still not commercial-launch approval. A04/A05 offline authorization and snapshots, A08 QR request claiming, A09 cursor pagination, A10 rounding, A11 tenant status, A12 session revocation and A13 socket assignment are implemented locally. A14 connector authentication, deeper reporting/tax classification, A16 production-runtime capacity, receipt printing, real providers, operational recovery, dependency remediation and legal/customer readiness remain open. The edge client now requires a provisioned `EDGE_DEVICE_ID` (terminal id or device token) for cloud sync; generated development IDs are intentionally rejected.

Inventory production batches and central-kitchen transfers still need a coordinated lock/valuation review across all materials and documents. This batch fixes the demonstrated receiving/wastage races; it does not claim all inventory mutation paths are concurrency-safe. Other relationship ownership paths and coupon limits across different orders require continued review.

Settlement retries currently return the existing “order is not open” error after one successful settlement rather than a new operation-key response contract. This prevents duplicate effects; a polished recoverable retry UX remains follow-up work.

Rollout must apply migrations, drain older API instances that do not honor these locking/reservation rules, then start the new version and run staging reconciliation checks. Retain a backup and do not roll financial traffic back to the unsafe old implementation while refund reservations are active. No deployment was performed in this batch.

These changes prevent new occurrences on the updated paths. They do not automatically reverse historical duplicate payments/refunds, repair old foreign table links or reconstruct lost stock movements. Review any existing financial and relationship anomalies before release; corrections must retain an audit trail rather than delete transactions.
