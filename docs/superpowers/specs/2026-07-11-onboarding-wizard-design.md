# Onboarding Wizard (Phase 2) — Design Spec

**Date:** 2026-07-11
**Status:** Approved design → ready for implementation plan
**Branch:** `feat/onboarding-wizard` (stacked on `feat/tenant-provisioning` / Phase 1)

## Problem

Phase 1 gives us a provisioning engine that creates a bare tenant (one empty "Main Outlet", an Owner user, standard roles). But a freshly-provisioned owner lands in an empty Console with no menu, no configured outlet, and no tables — not usable. Phase 2 adds a first-run onboarding wizard that takes the owner from empty account to a usable POS + Scan-&-Order setup.

## Goals

1. A guided, first-run **onboarding wizard** in the staff app, shown once per tenant.
2. The supporting **API endpoints** the wizard needs (outlet update, starter menu, tables/QR, tenant status + complete).
3. Get the owner to a state where they can immediately take orders (configured outlet + a menu) and, optionally, run dine-in Scan & Order (tables with QR codes).

## Non-goals (out of scope)

- **Staff invites + email** — deferred to Phase 3 (invites are much better emailed; no email provider exists yet). The owner account operates everything during onboarding.
- **Public signup** — Phase 3.
- **Logo / image upload** — no image storage pipeline exists; branding is theme-only for now.
- **Billing**, password-reset, custom domains.
- **Floor-plan design** — the tables step auto-creates a single "Main" area; multi-area layout stays in Console.

## Key decisions (settled in brainstorm)

- Staff invites deferred to Phase 3.
- Starter menu is **one fixed, cuisine-neutral sample template** (not a cuisine picker).
- The tables step **auto-creates a single "Main" area**; the owner just picks a table count.
- **No migration** — `Outlet` already has `address/gstin/placeOfSupply/upiVpa`; `Tenant.onboardedAt` was added in Phase 1.

---

## Backend — new endpoints (all authenticated + tenant-scoped)

### 1. Update outlet — `PATCH /outlets/:outletId`
`outlets` is read-only today. Add an update route on `OutletsController`.
- Body (Zod `UpdateOutletSchema`, all optional): `{ name?, address?, gstin?, placeOfSupply?, upiVpa? }`.
- Permission: `settings.manage` (Owner has `*`).
- Scoping: a scoped read first (`findFirst({ id: outletId, tenantId })` → 404 if not found) before the update — mirrors the `requireX` pattern; the Prisma tenant-guard passes update-by-id through unscoped, so this pre-read is required (same lesson as Phase 1's stock-toggle IDOR fix).

### 2. Apply starter menu — `POST /outlets/:outletId/menu/apply-template`
- Adds to the menu-admin surface (permission `menu.manage`).
- Creates a fixed template in ONE transaction, scoped to the outlet's tenant: categories **Starters / Main Course / Breads / Beverages**, each with 3–4 plainly-named items at simple prices (exact contents finalized in the plan). Each item `inStock: true`.
- Behavior: appends the template. The wizard only calls it when the owner chooses "use sample menu."
- Returns `{ categoriesCreated: number, itemsCreated: number }`.

### 3. Areas + tables — `POST /outlets/:outletId/areas`, `POST /outlets/:outletId/tables`
- `POST areas` → `{ name }` → creates an `Area` for the outlet. Returns the area.
- `POST tables` → `{ areaId: string, count: number }` (count 1–50) → creates `count` tables named `Table 1..N` under that area, each with a generated unique `publicToken` (same token scheme used elsewhere for Scan & Order). Returns the created tables (id, name, publicToken).
- Permission: `settings.manage`.
- The wizard's tables step: `POST areas {name:"Main"}` then `POST tables {areaId, count}`. (If the outlet already has an area, the wizard reuses the first one rather than making duplicates — it reads `GET /outlets/:id/tables`/areas first, or the areas endpoint is idempotent-by-name; simplest: the wizard creates "Main" only if no area exists.)

### 4. Tenant status + complete — `GET /tenant`, `POST /tenant/onboarding/complete`
New small `TenantController` (tenant resolved from the JWT):
- `GET /tenant` → `{ id, name, status, onboardedAt, createdVia }` for the caller's tenant. Used by the frontend to decide whether to show the wizard. Authenticated (any role).
- `POST /tenant/onboarding/complete` → sets `onboardedAt = now()` for the caller's tenant; permission `settings.manage`. Idempotent (setting an already-set value is harmless).

### Reused (no change)
- Brand/theme update — existing brands endpoint (already used by the Console appearance tab).
- Menu category/item creation semantics — the template endpoint reuses the same create logic/shape as `menu-admin`.

---

## Frontend — `apps/dashboard/app/onboarding/`

### Gating
After login, the app fetches `GET /tenant`. If `onboardedAt == null` AND the user's role is Owner (has `settings.manage`), route to `/onboarding`. Non-owners (cashier/kitchen) never see the wizard even if `onboardedAt` is null — they go to their surface as today. Once `onboardedAt` is set, `/onboarding` redirects into Console. Wire this into the existing session/routing layer (`SessionProvider` + the root role-router), following the current pattern — do not duplicate routing logic.

### Steps (a single multi-step form component; essentials required, ③④ skippable)
1. **Brand & theme** — restaurant name + theme picker (reuse the brands update call). Required.
2. **Outlet & GST** — name, address, GSTIN, place-of-supply (state code), UPI VPA → `PATCH /outlets/:id`. Required (name+address; GST fields optional inputs).
3. **Starter menu** — radio: "Add a sample menu I can edit" vs "Start with a blank menu." If sample → `POST apply-template`. Skippable (defaults to blank).
4. **Tables & QR** — number input (how many tables). On next → create "Main" area + tables, then render each table's QR (using the existing `qrcode` dependency, pointing at the diner Scan & Order URL for that `publicToken`) with a print/download affordance. Skippable.
5. **Finish** — `POST /tenant/onboarding/complete` → redirect to Console.

Progress indicator, Back/Next/Skip controls, loading + error states per step (reuse the Console's existing error-banner pattern, not a new system). Styling consistent with the existing staff-app tokens.

---

## Which outlet
The provisioning engine creates exactly one outlet. The wizard operates on the owner's first outlet (`AuthUser.outletIds[0]`, cross-checked via `GET /outlets`). Multi-outlet setup stays in Console.

## Testing strategy

- **API (vitest + test DB):** for each endpoint — happy path + tenant-scoping (a caller cannot PATCH/apply-template/create-tables against an outlet in another tenant → 404/forbidden). `apply-template` creates the expected category/item counts. `complete-onboarding` sets `onboardedAt`; `GET /tenant` reflects it. Add an e2e (supertest, using the Phase-1 harness) proving `PATCH /outlets/:id` rejects a non-owner/cross-tenant caller.
- **Frontend:** typecheck/build gate; the wizard flow verified end-to-end with the run skill against the real stack (Next dev + API), since multi-step UI isn't meaningfully unit-tested.

## Rollout

1. Backend endpoints (outlet PATCH, apply-template, areas/tables, tenant status/complete) with tests.
2. Frontend wizard + gating.
3. Manual/run verification of the full flow: provision a tenant (Phase 1) → log in as its owner → complete the wizard → confirm a configured outlet, a menu, tables with working QR codes, and that the wizard doesn't reappear.

## Open questions / to confirm during implementation

- Exact starter-menu contents (category + item names/prices) — cuisine-neutral, finalized in the plan.
- The precise diner Scan & Order URL shape to encode in table QRs (confirm against `apps/order` routing + how the Console's existing `ScanOrderTab` builds table-QR URLs, and reuse that).
- Whether to gate the wizard purely on `onboardedAt` or also offer a "skip onboarding" escape hatch for owners who prefer Console directly (default: a "Skip for now" on the final step that still sets `onboardedAt`).
