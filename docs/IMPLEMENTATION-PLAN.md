# Commercial readiness implementation plan

Started 21 September 2026. Baseline: [commercial audit](audit-2026-09-21/COMMERCIAL-READINESS-AUDIT.md). Existing local changes are preserved. Completion means verified behavior, not merely code written. Deployment is a separate release step after validation.

Product positioning and competitor rationale remain in the [market roadmap](audit-2026-09-21/MARKET-AND-ROADMAP.md). The proposed initial segment is one to five outlet cafes/QSRs, subject to customer validation. Prioritize reliable day close, offline recovery and supported hardware before expanding module breadth or adding AI.

| Sequence | Scope | Verification / release gate | Status |
|---|---|---|---|
| 1. Transaction integrity | A01 duplicate settlement; A02 cumulative refunds and cash ledger atomicity; A03 foreign table relationships; A06 lost receiving/wastage updates; A07 table occupancy; A15 modifier validation | Database-backed concurrency, rollback, ownership and boundary regressions, followed by existing tests/typecheck/build | First batch implemented and verified locally; limitations in results |
| 2. Offline and request consistency | A04 device authorization/payment validation; A05 immutable offline price/tax snapshots and visible conflicts; A08 atomic QR acceptance; A09 composite sync cursor | Real edge-to-API round trip, price changes during outage, duplicate delivery, tied timestamps and concurrent acceptance | Implemented locally; needs edge/provider pilot verification |
| 3. Identity and invoices | A10 rounding; A11 tenant state; A12 session revocation; A13 sockets; A14 connector authentication; correct invoice/report snapshots and business dates | Authorization matrix, tax reconciliation and session/socket lifecycle tests | Partially implemented: rounding, tenant/session/socket guards; connector and reporting review remain |
| 4. Real operating loop | Receipt printing and recovery; real payment/refund, aggregator, tax and messaging providers; explicit feature gates for mocks | Provider sandboxes/certification and supported physical hardware; order-to-day-close and reversal rehearsals | Requires provider/hardware setup as implementation reaches each integration |
| 5. Secure deployment | Dependency remediation; repeatable secrets/config; build identity; minimal images; backup restore, rollback, monitoring; investigate A16 on production runtime | Clean environment deployment, vulnerability triage, load/soak and recovery evidence | Planned |
| 6. Pilot and commercialization | Narrow initial restaurant segment; migration, support, entitlements, contracts/privacy, transparent pricing | Instrumented pilot through peak shifts/outages with no unexplained financial variance; professional tax/legal review | Planned |
| 7. Differentiation | Owner exception digest, source-linked insights, validated invoice OCR; expand only after trust gates | Measured operational benefit and supported source records | Later |

## First implementation batch

Serialize modifications of an order before calculating/recording settlement, and prevent adding items to a concurrently settled order. Serialize table occupancy checks and validate tenant/outlet ownership. Serialize refund balance reservations and keep cash movements in the same transaction. Preserve pending/uncertain provider refunds rather than allowing the balance to be refunded again. Serialize stock reads used for weighted costs and avoid read/overwrite wastage updates. Validate modifiers at the authoritative order boundary.

Use targeted row locks and database transactions with explicit ownership predicates. Avoid treating a retryable database timeout as permission to repeat an external financial operation. Add meaningful integration regressions against disposable PostgreSQL; do not use the customer's live database for destructive tests.

This batch does not certify external integrations or close every audit finding. Later batches retain explicit gates for offline snapshots, authentication lifecycle, tax rules, production operations and hardware.

## Working rules

- Keep the audit evidence immutable; record remediation results separately.
- Preserve pre-existing working-tree edits; no broad resets or opportunistic rewrites.
- Every completed finding needs regression evidence and any remaining limitation documented here.
- Do not silently mark mock provider responses as verified real payments or tax acknowledgements.
- Request missing merchant/provider configuration when a concrete integration requires it; it does not block local correctness fixes.
- No commercial-ready claim until all relevant release gates are met.

## Next implementation batch: offline and request consistency

1. Bind sync requests to an active registered device, tenant and outlet; test revoked devices and stale credentials. Ensure legitimate edge provisioning is updated before enforcing a new server contract.
2. Version the offline payload and persist immutable price/tax/discount facts. Define authorization of historical catalog prices; do not trust arbitrary client-supplied money merely because it is called a snapshot.
3. Reject unpaid or mismatched terminal sales, retain conflicts in the edge outbox, and surface an actionable operator error. Keep retries deduplicated without clearing unresolved entries.
4. Make QR request state transition, order creation and token assignment one atomic operation; coordinate accept/reject races.
5. Introduce a stable composite sync cursor and corresponding ordering/index, with compatibility handling for existing timestamp cursors.
6. Verify edge-to-API offline sale, catalog changes, outages/reconnect, tied timestamps, duplicate delivery, device revocation and two-staff QR acceptance.

Batch 1 changes and evidence are recorded in [implementation results](implementation-2026-09-21/RESULTS.md). Unknown provider outcomes and incomplete inventory production/transfer concurrency are explicitly retained as follow-up work there.
