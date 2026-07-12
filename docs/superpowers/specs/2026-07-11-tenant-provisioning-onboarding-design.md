# Tenant Provisioning & Onboarding — Design Spec

**Date:** 2026-07-11
**Status:** Approved design → ready for implementation plan
**Branch:** `feat/tenant-provisioning`

## Problem

Stello Kitchens is a multi-tenant restaurant platform, but the *only* way to
create a tenant today is editing and re-running `apps/api/prisma/seed.ts`. There
is no signup, no admin provisioning, and no onboarding. A prospect cannot become
a customer. This is the #1 blocker to commercializing the product (see the SaaS
readiness audit, 2026-07-11).

## Goals

1. A **shared provisioning engine** that atomically creates a complete, usable
   tenant (Tenant → Brand → first Outlet → standard roles → Owner user).
2. Two entry paths onto that engine:
   - **Admin provisioning** — a platform super-admin creates a tenant for anyone
     (works immediately, no email dependency).
   - **Public self-serve signup** — `/signup` with email verification, behind a
     feature flag that stays OFF until an email provider is configured.
3. A **first-run onboarding wizard** that takes a new owner from empty account to
   a usable POS.
4. Minimal **subscription-status scaffolding** (trial/active/suspended) to prepare
   for billing — but no billing logic in this scope.

## Non-goals (explicitly out of scope)

- Billing / payment gateway / plan enforcement (separate future work). We only
  store a status + trial date now; nothing reads them yet.
- Choosing/integrating a real email vendor. We ship a pluggable `EmailProvider`
  seam with a logging dev implementation; a real provider is a config swap later.
- Password-reset UI. The `AuthToken` infrastructure introduced here supports it,
  but wiring the reset flow is a fast-follow, not this spec.
- Per-tenant custom domains (row-level tenancy on one shared domain is unchanged).

## Key decisions (settled in brainstorm)

- **Verify-then-create** for public signup: a `PendingSignup` row holds the
  request until the email link is clicked; only then does the engine create a
  real tenant. Bots/unverified attempts never mint tenants.
- **Provisioning runs unscoped.** It creates a *new* `tenantId`, so it must not
  inherit any request tenant context. Use the existing (currently unused)
  `runUnscoped()` (`apps/api/src/common/tenant-context.ts`) to bypass the Prisma
  tenant extension for the provisioning transaction.
- **Super-admin = `User.isPlatformAdmin` flag**, bootstrapped once via env. Kept
  as a boolean flag (not a fake "platform tenant") for simplicity.
- Trial length default: **14 days**.

---

## Data model changes (one Prisma migration)

**`User`**
- `isPlatformAdmin Boolean @default(false)` — cross-tenant super-admin.
- `emailVerified   Boolean @default(false)`.

**`Tenant`**
- `status       TenantStatus @default(TRIAL)` — enum `TRIAL | ACTIVE | SUSPENDED`.
- `trialEndsAt  DateTime?`
- `onboardedAt  DateTime?` — null until the wizard is finished; gates the wizard.
- `createdVia   TenantOrigin @default(SEED)` — enum `SEED | ADMIN | SIGNUP`.

**`Outlet`** (add if missing — needed by onboarding tax/address step)
- `addressLine  String?`, `city String?`, `state String?`, `pincode String?`
- `gstin        String?` (seller GSTIN), `placeOfSupply String?`
- (Verify against current schema during implementation; add only what's absent.)

**`PendingSignup`** (new)
- `id, email @unique, passwordHash, restaurantName, ownerName, tokenHash,
   expiresAt, createdAt`. Cleaned up on verify or by a TTL sweep.

**`AuthToken`** (new — staff invites now; password-reset reuses later)
- `id, tenantId, userId?, type (INVITE | PASSWORD_RESET), tokenHash, expiresAt,
   usedAt?, createdAt`. Tokens are stored **hashed**; the raw token only ever
   travels in the emailed/returned link.

All tokens: random 32-byte, hashed at rest (sha256), single-use, expiry
(signup/invite 24h).

---

## Component: Provisioning engine

`apps/api/src/provisioning/provisioning.service.ts`

```
provisionTenant(input: {
  restaurantName: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword?: string;      // null → owner created pending an INVITE set-password
  createdVia: "ADMIN" | "SIGNUP";
  themeId?: string;
}): Promise<{ tenant; owner; accessToken? }>
```

Runs inside `runUnscoped(() => prisma.$transaction(...))` and creates, in order:
1. `Tenant` (status TRIAL, trialEndsAt = now + 14d, createdVia).
2. `Brand` (default theme, or `themeId`).
3. Standard roles mirroring the seed: **Owner** `["*"]`, **Cashier**
   `["orders.create","orders.settle","menu.stock"]`, **Kitchen**
   `["kds.operate","menu.stock"]`.
4. First `Outlet` ("Main Outlet"; address/GST left blank for onboarding).
5. Owner `User` (roleId = Owner, `emailVerified` per path), linked via `UserOutlet`.
6. `AuditLog` entry `TENANT_CREATED`.

Returns the created tenant + owner. Issues an `accessToken` for the signup-verify
path (auto-login after verification).

---

## Path A — Admin provisioning

- **Guard:** new `PlatformAdminGuard` (`apps/api/src/common/`) — allows only
  `user.isPlatformAdmin`. `AuthUser` (in `@stello/shared`) gains `isPlatformAdmin`,
  resolved from DB in `AuthService` (`toAuthUser`/`resolveUser`).
- **Controller:** `PlatformController` under `@Controller("platform")`, guarded.
  - `POST /platform/tenants` → body `{ restaurantName, ownerEmail, ownerName,
    ownerPassword? }` → calls engine (`createdVia: ADMIN`, `emailVerified: true`).
    If `ownerPassword` omitted, creates an `INVITE` token and returns a one-time
    set-password link (so it works with no email provider — admin hands it over).
  - `GET /platform/tenants` → list tenants (id, name, status, createdVia,
    outlet/user counts) for a minimal super-admin overview.
- **Bootstrap:** env `PLATFORM_ADMIN_EMAIL` + a one-shot script
  `apps/api/prisma/provision-platform-admin.ts` (pnpm script
  `provision:platform-admin`) that sets `isPlatformAdmin = true` on that user.
  Resolves the chicken-and-egg for the first super-admin.

---

## Path B — Public self-serve signup

Feature-flagged by `SIGNUP_PUBLIC_ENABLED` (default false; intended to be enabled
only once a real `EmailProvider` is configured). When off, the routes 404/403.

- `POST /signup` (`@Public`, tightly throttled) → body `{ restaurantName,
  ownerName, email, password }`:
  - Reject if `email` already exists as a `User` or `PendingSignup`
    ("An account with this email already exists").
  - Create `PendingSignup` (hashed password + token), send verify email via
    `EmailProvider` with link `…/signup/verify?token=…`.
  - Response: `{ status: "verification_sent" }` (never leaks whether email existed
    beyond the explicit conflict above — acceptable for signup).
- `POST /signup/verify` (`@Public`) → body `{ token }`:
  - Look up by `tokenHash`, check expiry/single-use. Call engine
    (`createdVia: SIGNUP`, `emailVerified: true`), delete the `PendingSignup`,
    return `{ accessToken, user }` (auto-login).
- A scheduled/lazy sweep removes expired `PendingSignup` rows.

---

## Component: Email seam

`apps/api/src/email/email.provider.ts` — `EmailProvider` interface
(`sendVerification`, `sendInvite`) plus `LoggingEmailProvider` (logs the link in
dev; mirrors the existing `NotificationProvider` seam in `crm`/`loyalty`). DI
token `EMAIL_PROVIDER`. Real providers (Resend/SMTP/SES) are a later config swap.

---

## Component: Onboarding wizard (dashboard)

Route `apps/dashboard/app/onboarding/`. After login, if the user is an Owner and
`tenant.onboardedAt == null`, they are routed here. Steps:

**Essential**
1. **Brand & theme** — restaurant name + theme picker. Reuses the brands update
   endpoint (already exists; used by `AppearanceTab`).
2. **First outlet** — name + address. Needs a **new** `PATCH /outlets/:id`
   endpoint (outlets is currently read-only) to update outlet details.
3. **GST / tax** — outlet `gstin` + `placeOfSupply` (state). Same PATCH endpoint.

**Optional (each skippable)**
4. **Starter menu** — "Use a sample menu" vs "Start blank". Needs a **new**
   `POST /outlets/:id/menu/apply-template` that creates a small predefined set of
   categories + items; or skip → empty menu.
5. **Invite staff** — add cashier/kitchen by email. Needs **new** invite
   endpoints: `POST /tenant/invites` (create `User` shell + `INVITE` `AuthToken`;
   email the link or, if email unconfigured, return the shareable link),
   `POST /invite/accept` (`@Public`, `{ token, password }` → set password, verify).
6. **Tables & QR** — create N dining tables and show their QR codes. Reuses table
   creation (verify a create-table endpoint exists in scan-order/devices; add a
   minimal one if not). QR rendering already exists client-side (`qrcode`).

"Finish" sets `tenant.onboardedAt = now()` (new `POST /tenant/complete-onboarding`)
and routes into Console. Skipped optional steps simply advance.

**New public signup page:** `apps/dashboard/app/signup/` (only linked/enabled when
`SIGNUP_PUBLIC_ENABLED`). **Minimal super-admin page:** `apps/dashboard/app/platform/`
(create-restaurant form + tenant list), visible only to `isPlatformAdmin`.

---

## Security considerations

- Public `/signup` + `/signup/verify` + `/invite/accept` are throttled (the
  global `ThrottlerModule` is in place; add tight per-route limits).
- All tokens hashed at rest, single-use, short expiry.
- `PlatformAdminGuard` is the only gate to cross-tenant creation; provisioning is
  otherwise unreachable. The engine writes an `AuditLog` for every tenant created.
- Email enumeration: signup returns a generic "verification sent"; the only
  explicit conflict is the pre-check, which is standard for signup UX.
- Provisioning must run **unscoped** — a bug here (inheriting the caller's
  tenantId into creates) would cross-link data between tenants; covered by tests.

## Testing strategy

- Unit: `ProvisioningService` creates exactly the expected graph with correct
  tenantId on every row; roles/permissions match the seed; runs unscoped even
  when called by a platform-admin who belongs to another tenant.
- Integration: admin path (with and without `ownerPassword`), signup happy path
  (pending → verify → login), expired/invalid/reused token rejection, duplicate
  email rejection, feature-flag off → signup blocked.
- Guard: non-platform-admin is refused on `/platform/*`.
- Onboarding: `onboardedAt` gating (wizard shows once), skippable steps, outlet
  PATCH scoping (can't PATCH another tenant's outlet).

## Rollout

1. Migration + engine + admin path + bootstrap script (usable immediately; you
   provision the first real tenants by hand).
2. Onboarding wizard + the new outlet/menu/invite/table endpoints it needs.
3. Public signup path + email seam (kept flagged off until an email provider is
   chosen and configured).

## Open questions / assumptions to confirm during implementation

- Exact current `Outlet` schema fields (add address/GST only if absent).
- Whether a create-table endpoint already exists (scan-order/devices) or must be
  added for step 6.
- Sample-menu template contents (small, cuisine-neutral; final content TBD in the
  plan).
