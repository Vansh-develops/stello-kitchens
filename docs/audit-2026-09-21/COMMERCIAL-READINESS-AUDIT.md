# Stello Kitchens: commercial readiness audit

Assessment date: **21 September 2026**. Decision: **NO-GO for an unrestricted paid commercial launch.**

The application has a substantial working foundation: billing, KOT/KDS, inventory, QR ordering, loyalty, reporting and an offline engine. However, reproduced defects can duplicate payments and orders, over-refund a sale, lose inventory changes, corrupt offline reconciliation and cross tenant boundaries. Several advertised integration paths still terminate in mock or logging providers. Resolve these before a controlled customer pilot involving real money; complete the release gates below before general availability.

## Scope and confidence

Audited the current working tree in `C:\Projects\Pet Pooja Clone`, based on commit `141e65867e932e1da83ec50d20314fc0e171c580`, including pre-existing uncommitted changes. This was a full software audit, not a review of a separately supplied document. No product source was changed by this audit. New scripts, logs and reports are in this directory.

Assumed initial market: Indian independent restaurants and small chains. That assumption follows the implementation's GST, UPI and aggregator features; founder/customer validation is still needed. See [competitor research and roadmap](MARKET-AND-ROADMAP.md).

Evidence labels used below:

- **Reproduced:** exercised against isolated local services and databases, with saved results.
- **Reviewed:** established from source/configuration; not a claim of a successfully executed production exploit.
- **Live observed:** a read-only public endpoint or the advertised login flow was checked.
- **Unverified:** requires production access, a real provider, physical hardware, more devices or a longer trial.

This is not an exhaustive penetration test, legal certification, payment certification or production capacity certification. Local and deployed versions demonstrably differ. Local defects must not be described as proven exploitation of the live server.

## Is it live on the server?

**Yes: the website and API health endpoint were reachable.** At approximately 07:18 IST on 21 September:

| Public check | Result |
|---|---|
| `https://kitchens.stellotechs.com/` | HTTP 200 |
| `/api/v1/health` | HTTP 200, `status: ok` |
| `/api/v1/health/ready` | HTTP 404; the local implementation returns 200 |
| `/api/v1/outlets` without authentication | HTTP 401 |
| Login using the credentials advertised on the login screen | Rejected: invalid email or password |

Reachability is not proof that the complete product is usable or commercially ready. The deployed commit, authenticated production workflows, server configuration and real integrations were not verified. The displayed demo credentials did **not** establish an exposed default account. Remove misleading credentials from the production login screen or provide a deliberately isolated, maintained demo environment. Evidence: [live results](live-results.json); browser observations described below.

## Tests executed

| Area | Outcome | Evidence |
|---|---|---|
| Type checking | All six workspaces passed | [typecheck.log](typecheck.log) |
| Production builds | All six workspaces passed | [build.log](build.log) |
| Existing automated suite | 58 tests passed: 23 shared, 35 API | [test.log](test.log) |
| Existing smoke scripts | 18 scripts, 218 assertions passed after fixture correction and a Node 24 rerun | [evidence index](EVIDENCE-AND-REPRODUCTION.md) |
| New targeted invariant tests | **31 assertions: 16 passed, 15 failed** | [API](api-results.json), [extended](extended-results.json), [stock/connector](stock-connector-results.json) |
| Small local concurrency sample | 49/50 create-and-settle workflows completed; one HTTP 500 | [load results](local-load-results.json) |
| Clean database initialization | Actual migrations and seed completed | [migrations](migrations.log), [seed](seed.log) |
| Local database restore | PostgreSQL custom-format dump restored; 234 orders in source and restored DB at that point | [evidence index](EVIDENCE-AND-REPRODUCTION.md) |
| Production dependency audit | 28 advisories: 2 critical, 14 high, 10 moderate, 2 low | [dependency-audit.json](dependency-audit.json) |

The passing tests do not contradict the failures: normal happy paths and sequential retries are covered better than concurrency, cumulative limits, relationship ownership and offline money reconciliation. Existing smoke coverage is valuable but is not all included in the normal CI test command.

### Browser and workflow verification

Locally exercised login, outlet selection, onboarding completion, the owner console, takeaway billing, Chicken 65 selection, KOT submission, cash settlement and KDS viewing. A ₹304.50 sale settled as bill B-19. KDS displayed tickets and connected with a LIVE indicator after the local socket origin was correctly configured. An initial RECONNECTING indicator was local test configuration, not a product defect.

The “Settle & print” action settled the sale but did not invoke a receipt print path in the reviewed callback. Real thermal printing was not tested. The foreign table reference from the tenant isolation test also appeared in staff interfaces. Diner QR and kiosk behavior received API/smoke coverage, not a complete browser/device matrix. Accessibility, mobile layouts and physical touch-screen usability remain unverified.

## Prioritized defects and acceptance criteria

**P0** means release blocker involving money, tenant boundaries or core data integrity. **P1** means a serious reliability, security or operational gap that must be resolved for the affected launch scope. Priorities describe this product's release risk, not CVSS scores.

### A01 — P0: duplicate settlement records under concurrency

**Reproduced.** Three concurrent settlement requests for one ₹304.50 order all returned 201 and created three payment records totalling ₹913.50. Sequential duplicate settlement correctly returned 400. To make the race repeatable, the test briefly held the order row lock so the competing requests reached the pre-check before a winner committed. This is a deterministic contention test, not a claimed natural-frequency estimate.

Source: `apps/api/src/orders/orders.service.ts`, settlement pre-check outside the transaction. Evidence: `api-results.json`.

Fix: atomically claim the permitted state transition within the transaction, enforce a settlement operation/idempotency key and persist payment, bill and side effects consistently. Provider calls also need provider-side idempotency and reconciliation; a database transaction alone cannot make remote capture atomic.

Acceptance: 20 concurrent identical submissions produce one financial effect and stable retry responses; distinct conflicting submissions fail safely. Retry after a connection drop must not duplicate payment, invoice, loyalty or stock effects.

### A02 — P0: cumulative refunds exceed the sale

**Reproduced.** Two full cash refunds of ₹304.50 each were accepted for one ₹304.50 sale: total refunded ₹609. The code checks the individual request against the original sale rather than the remaining refundable balance.

Source: `apps/api/src/payments/cash.service.ts`. Evidence: `api-results.json`.

Fix: a transactional refund ledger with cumulative balance checks, reservation of pending refunds, idempotency and linked cash/provider movements. Acceptance: partial, full, concurrent, failed and retried refunds never exceed captured value and reconcile to the day close.

### A03 — P0: foreign-tenant table reference accepted and disclosed

**Reproduced.** A cashier created an order in their own outlet while supplying a valid table ID belonging to a different tenant. The response returned that table's private name and stored the foreign relationship. Direct foreign-menu reads were correctly denied. The test supplied a known fixture ID; it did not demonstrate discovery of arbitrary IDs.

Source: `apps/api/src/orders/orders.service.ts`; tenant extension in `apps/api/src/prisma/prisma.service.ts`. Evidence: `api-results.json` and local staff UI observation.

Fix: validate every referenced table/menu/customer/payment/device against tenant and outlet ownership, then enforce ownership in transactional queries and database relationships where possible. Audit nested relations and mutation paths; top-level read filtering is insufficient. Consider database row-level security as additional defense, not a substitute for application authorization.

Acceptance: a cross-tenant and cross-outlet matrix covering read, create, update, delete, nested relation, export, sync and socket paths rejects unauthorized references without revealing private fields.

### A04 — P0: offline push can create an unpaid settled sale

**Reproduced.** A push from an unregistered device with `SETTLED` status and an empty payments array was accepted and applied to a ₹304.50 sale. There were zero payment records. Normal online underpayment validation worked, demonstrating inconsistent entry-point controls.

Source: `apps/api/src/sync/sync.service.ts`, `orders.service.ts` / `applySyncedOrder`. Evidence: `api-results.json`.

Fix: bind pushes to an active registered device and outlet; enforce an explicit offline authorization policy, payment balance, allowed transitions and immutable sale facts. Accepted manual tender records must be distinguished from verified provider capture. Acceptance: missing, negative, mismatched and unauthorized payment/device payloads cannot silently create completed sales.

### A05 — P0: offline sync silently reprices an already-paid sale

**Reproduced.** An offline ₹304.50 sale was collected locally. After changing the menu price, sync stored a ₹315 server total while retaining ₹304.50 in payments; the edge queue reported zero pending entries.

Source: synced order handling uses current menu pricing through order construction. Evidence: `extended-results.json`.

Fix: persist immutable line price, tax, discount, currency, catalog version and rounding facts at sale time; validate them under a documented offline policy. Conflicts must remain visible and recoverable, not be acknowledged as fully reconciled. Acceptance: catalog, tax and promotion changes during disconnection preserve the sale's financial history or enter a visible resolution queue.

### A06 — P0: concurrent stock receipts lose quantity

**Reproduced.** Starting stock 10, two concurrent receipts of five each both returned 201, but stock became 15 instead of 20. A short row lock made the overlap deterministic.

Source: `apps/api/src/inventory/inventory.service.ts`. Evidence: `stock-connector-results.json`.

Fix: an append-only movement ledger with atomic quantity changes, transactional valuation and idempotent source documents. Acceptance: concurrent receiving, consumption, adjustment and reversal preserve quantity and cost conservation; reconciling the ledger reproduces the displayed balance.

### A07 — P1: competing orders can occupy one table

**Reproduced.** Two concurrent create requests produced two open orders for the same table despite the current single-open-order pre-check. Evidence: `api-results.json`.

Fix: an atomic table occupancy claim or database constraint for the intended lifecycle. If multiple checks per table are intentional, model that explicitly. Acceptance: concurrent terminals obey the chosen split/merge/occupancy rules, including void and transfer.

### A08 — P1: accepting one QR request can create two orders

**Reproduced.** Two simultaneous accept calls for the same pending request both succeeded and created separate orders. Source: `apps/api/src/scan-order/scan-order.service.ts`. Evidence: `api-results.json`.

Fix: atomically transition the request and link exactly one order; ensure token allocation is concurrency-safe. Acceptance: staff double-taps, retries and two-terminal acceptance create one order/KOT and a stable customer status.

### A09 — P1: pull pagination drops orders with tied timestamps

**Reproduced.** A controlled fixture created 205 rows with the same timestamp. The first page returned 200; the next returned zero, losing five. Future-dated fixture timestamps isolated the test; the defect is the timestamp-only boundary, not clock travel.

Source: `apps/api/src/sync/sync.service.ts`, `take: 200` with a strict timestamp comparison. Evidence: `extended-results.json`.

Fix: stable composite cursor `(updatedAt, id)`, corresponding ordering/indexing and a documented deletion/change protocol. Acceptance: large timestamp ties, retries, concurrent writes and deletions yield complete, repeatable convergence.

### A10 — P1: invoice tax components do not reconcile

**Reproduced.** On a ₹1 item at 5%, order tax was ₹0.05, but separately rounded CGST and SGST were ₹0.03 each: invoice tax ₹0.06 while total remained ₹1.05.

Source: `apps/api/src/invoices/invoices.service.ts`, tax split and HSN summary construction. Evidence: `api-results.json`.

Fix: use integer minor units or a deliberate decimal strategy and deterministic remainder allocation. Acceptance: line, HSN, component, bill and refund totals reconcile across small values, mixed rates, discounts, inclusive pricing and credit notes.

### A11 — P1: suspension does not stop tenant access

**Reproduced.** Setting the fixture tenant to SUSPENDED still allowed an authenticated request with HTTP 200. Status was restored afterwards. Evidence: `extended-results.json`.

Fix: enforce tenant state centrally across HTTP, sockets, devices and workers, with explicitly designed read/export and emergency service policies. Acceptance: suspension, trial expiry, reinstatement and billing grace rules have documented and tested effects.

### A12 — P1: password reset does not revoke prior sessions

**Reproduced.** Password reset succeeded, but the old JWT still accessed `/auth/me` with HTTP 200. Evidence: `extended-results.json`.

Fix: session registry or token version/revocation with deliberate refresh-token lifecycle; revoke on password reset, user disable and sensitive role changes. Acceptance: existing tokens stop working within a stated revocation window across HTTP and sockets. Add MFA for owner/platform access before sensitive administration is widely exposed.

### A13 — P1: socket room authorization is weaker than HTTP authorization

**Reproduced.** A cashier restricted to one outlet joined a different outlet's socket room in the same tenant. The inspected event exposes change notifications/outlet IDs, not full order records; do not inflate this into proven full-order exfiltration.

Source: `apps/api/src/realtime/realtime.gateway.ts`. Evidence: `extended-results.json`.

Fix: validate active user, tenant, assigned outlet and permission before room join; re-evaluate on revocation. Acceptance: socket access matches the REST permission matrix and logout/disable removes ongoing access.

### A14 — P1: connector push endpoints accept unauthenticated calls

**Reproduced locally.** An unauthenticated POST to `/push/zomato/menu` returned 201. The fixture had zero mapped menu rows at that moment; this test did not exfiltrate populated menu data. Internet exposure depends on deployment routing and was not verified.

Source: `apps/connector/src/push.controller.ts`. Evidence: `stock-connector-results.json`.

Fix: authenticated service-to-service access, tenant/outlet authorization, network isolation and replay/rate controls. Acceptance: every outbound trigger requires a scoped identity even when the connector port is accidentally reachable.

### A15 — P1: modifier constraints are not enforced at the API boundary

**Reproduced.** A modifier group with `maxSelect: 3` accepted four duplicate add-on IDs. Source: order input/price construction. Evidence: `stock-connector-results.json`.

Fix: server-side min/max, uniqueness, group ownership, availability and channel rules shared by online, QR, aggregator and offline ingestion. Acceptance: malformed combinations are rejected consistently before pricing or KOT creation.

### A16 — P1: local transaction acquisition fails at modest concurrency

**Reproduced once in the sample.** Fifty workflows with five workers issued 99 requests: 49 sales completed with unique bill numbers, one create returned 500. API log identifies Prisma P2028: “Unable to start a transaction in the given time.” Elapsed 2.2 seconds; request p50 54 ms, p95 106 ms, p99 2,144 ms.

These are local Windows/Node 23/PostgreSQL-in-Docker measurements, not a throughput claim for the Linux/Node 24 deployment. Source log: [local-api.log](local-api.log); sample: [local-load-results.json](local-load-results.json).

Fix investigation: transaction scope, pool configuration, contention, bounded safe retries and observable error handling. Acceptance: repeat against the production runtime and realistic outlet/device load; establish capacity and latency targets with zero lost or duplicated financial effects, including timeout recovery.

## Additional release blockers from source and configuration review

### R01 — P0 for advertised integration scope: mock providers are wired into business flows

| Capability | Reviewed implementation | Release requirement |
|---|---|---|
| Online payments/refunds | `PaymentsModule` binds `MockRazorpayGateway`; simulated processed refunds and fallback UPI identity | Real merchant onboarding, signature/event verification, idempotency, settlement/reversal reconciliation and sandbox-to-live certification |
| E-invoice/e-way bill | `InvoicesModule` binds `MockGspProvider`; synthetic IRN and unsigned encoded QR | Approved provider integration, authentic acknowledgements, cancellation/retry and applicability rules |
| Signup, reset and invitations | `EmailModule` binds logging provider | Deliverable email, domain authentication, retry/bounce handling, safe token handling |
| SMS/OTP/campaigns | Logging notification provider | Production messaging provider, consent/template controls and delivery status |
| Scale/caller ID | Mock hardware bridge | Tested drivers and supported-device matrix |
| Aggregator outbound sync | Menu/stock operations include simulated/logging paths; some adapters explicitly stubbed | Partner contract, production credentials, certification and operational reconciliation |

Do not market mocks as integrations. Make production startup fail for required mock bindings, or explicitly disable and remove the corresponding feature from the sold package. Existing happy-path tests against mocks prove internal behavior only. Manual cash recording can still be a legitimate feature when clearly separated from verified digital collection.

### R02 — P1: “Settle & print” has no implemented print action in the reviewed path

`apps/dashboard/components/pos/SettleDialog.tsx` submits settlement; `Billing.tsx` closes/reset state and shows the bill reference. The reviewed path does not dispatch a print job. Deliver a receipt engine, print queue, failure/retry UI, copy designation and audited reprints. Test USB/LAN printers, power loss, paper-out, duplicate callbacks, kitchen routing and multilingual receipts with real hardware.

### R03 — P1: tax classification and reporting semantics need correction and professional validation

The invoice split currently derives interstate treatment from the buyer's GSTIN state versus the seller's state. Restaurant services have a specific place-of-supply rule based on where the service is performed; an out-of-state customer GSTIN alone is not enough to select IGST. Existing IGST smoke tests encode the current assumption and therefore do not establish legal correctness. Review each offered transaction type, including other supplies and exemptions, with an Indian tax professional. [Official IGST Act, section 12(4)](https://upload.indiacode.nic.in/showfile?actid=AC_CEN_2_2_00043_201713_1517807328116&filename=a2017-13.pdf&type=actfile).

Source review also found report time grouping based on creation/process-local dates and invoice HSN lookup from current menu data. Validate settlement date versus order date, outlet time zone, business-day cutover, refund/void adjustments and immutable invoice snapshots. Define a daily reconciliation equation and test it against the payment, refund, stock and tax ledgers. These additional reporting concerns were reviewed, not individually reproduced in this audit.

### R04 — P1: dependencies require security remediation

The installed Next.js 15.5.20 is covered by current advisories with patched 15.x versions starting at 15.5.24. Two critical advisories concern Windows-host filesystem behavior and AVIF image processing. The production image is Linux, so the Windows-specific issue must not be represented as a confirmed production RCE; AVIF exposure depends on reachable image-processing paths. Neither exploit was attempted. Patch and rebuild, then assess every reachable high-severity path. [Windows advisory](https://github.com/advisories/GHSA-p293-qw3h-jr36), [AVIF advisory](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4).

The 28 advisory count is a dependency audit snapshot, not 28 confirmed exploitable application flaws. Generate an SBOM, maintain a vulnerability triage record, and verify license obligations for distributed desktop binaries and dependencies using [licenses.json](licenses.json).

### R05 — P1: deployment reproducibility and operational readiness are incomplete

- The deployment generator provides database/JWT/connector secrets, while compose requires additional aggregator webhook secrets. A fresh install needs a validated, complete configuration workflow; source review found this mismatch, not a failed production deployment.
- Use immutable versioned image digests, least-privilege runtime users and a minimal production image. The reviewed Docker setup retains build tooling/source and uses mutable image tagging.
- Gate deployments on database readiness and publish a safe build/version identifier. Current live readiness behavior differs from local, and the basic health endpoint alone does not prove database availability.
- Migrations at startup require concurrency and rollback planning. Test additive/contract migrations with a previous-version client and a restored production-shaped database.
- Repository backup tooling and this audit's local restore are not evidence of encrypted off-site backups, scheduled success, point-in-time recovery or a met recovery objective. Verify those operationally and retain restore-drill evidence.
- Add centralized error tracking, tenant-safe structured logs, traces, sync backlog/age, payment variance, connector lag/dead-letter alerts, database saturation and synthetic checkout monitoring. Set owners and escalation routes.
- SQLite edge database/WAL/SHM files are tracked in the repository. Remove runtime data from version control after assessing history and retention needs; no claim of a secret leak is made here.

### R06 — P1: browser security and commercial data lifecycle need completion

Live HTML responses lacked CSP, HSTS and X-Frame-Options in the captured headers, although API responses included several security headers. Configure consistent HTML/API protection and a tested CSP. Review local-storage JWT exposure and the session design; no XSS exploit was demonstrated.

No complete customer-facing privacy/terms, retention/deletion/export workflow, subscription entitlement enforcement or operational incident process was established by this review. Some may exist outside the repository; obtain evidence rather than assume absence. Include processor/subprocessor contracts, support access auditing, billing/cancellation, data portability and customer communication.

India's final DPDP Rules were notified in November 2025 with staged commencement; it would be incorrect to claim every provision was already effective on this audit date. Map the actual launch date and business role to applicable duties, and implement notice, consent where required, access/deletion, retention and incident processes ahead of the relevant deadlines. [Official rules and corrigendum page](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?pageTitle=Digit).

GST's 30-day e-invoice reporting restriction applies to the specified AATO ₹10 crore-and-above population from April 2025; this is a reporting restriction, not a statement that ₹10 crore is the universal applicability threshold. Map mandates and exemptions separately. [GST advisory](https://einvoice6.gst.gov.in/content/revised-time-limit-for-e-invoice-reporting-for-businesses-with-aato-of-%E2%82%B910-crores-above/). Also establish a reportable-incident decision process against applicable [CERT-In directions](https://www.cert-in.org.in/Directions70B.jsp?trk=article-ssr-frontend-pulse_little-text-block).

## Release gates

| Gate | Required evidence before advancing |
|---|---|
| 1. Financial and tenant integrity | A01–A06 fixed; regression tests cover concurrency, retries and cross-tenant relationships; independent review of every financial entry point |
| 2. Operational correctness | A07–A16 resolved for included modules; tax/report reconciliation approved; immutable invoices and ledger totals agree |
| 3. Real-world integrations | Production-equivalent payment, print, messaging and aggregator tests; mocks disabled; refund and failure recovery rehearsed |
| 4. Deployable service | Patched dependencies, repeatable deployment, known build identity, alerting, off-site restore drill, rollback rehearsal and access review |
| 5. Controlled pilot | Representative restaurants use actual supported hardware through peak shifts, outages, day closes, refunds and support incidents; every financial variance explained |
| 6. General availability | Pilot exit criteria met, support capacity and incident ownership established, contracts/privacy/tax review completed, transparent pricing and onboarding/offboarding ready |

Suggested pilot exit criteria: no unexplained financial or stock discrepancies; no unreconciled paid offline orders; no lost/duplicate aggregator orders; all backup/restore and printer recovery drills pass; measured uptime/latency/support response satisfy the commitments you intend to sell. Choose numeric SLOs from instrumented pilot data and unit economics, not a promise inferred from this local sample.

## What remains untested

Authenticated production flows and deployed source provenance; real card/UPI captures and reversals; GSP/aggregator certification; real email/SMS delivery; actual printers/scales/caller-ID; sustained production-like load/soak; multi-terminal LAN outage and long-disconnection recovery; power-loss durability; full accessibility/browser/mobile matrix; independent adversarial penetration testing; production backup, failover and incident drills. These are concrete next validation tasks, not evidence that the observed defects are hypothetical.

The recommended product strategy and phased implementation backlog are in [MARKET-AND-ROADMAP.md](MARKET-AND-ROADMAP.md). Exact scripts, evidence and test limitations are indexed in [EVIDENCE-AND-REPRODUCTION.md](EVIDENCE-AND-REPRODUCTION.md).
