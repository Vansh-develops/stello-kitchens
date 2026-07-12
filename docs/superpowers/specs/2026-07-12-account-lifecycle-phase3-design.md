# Account Lifecycle (Phase 3) — Design Spec

**Date:** 2026-07-12
**Status:** Approved design → ready for implementation plan
**Branch:** `feat/account-lifecycle` (off `main`, which now contains Phases 1–2)

## Problem

The platform can provision tenants (Phase 1, admin-only) and onboard them (Phase 2), but the *self-serve account lifecycle* is missing: nobody can sign themselves up, a locked-out owner has no password recovery (a P1 audit gap), and owners can't invite staff (deferred from Phase 2). All three are email/token-based flows sharing one foundation.

## Goals

1. **Public self-serve signup** — a prospect creates their own restaurant at `/signup`, email-verified, feature-flagged so it stays off until an email vendor is configured.
2. **Password reset** — forgot-password recovery for any user. Closes the P1 "locked-out tenant has no way back" gap.
3. **Staff invites** — an owner invites cashier/kitchen users by email; makes onboarding's deferred "invite staff" step real.
4. A shared, pluggable **`EmailProvider`** seam + a **token** foundation all three reuse.

## Non-goals (out of scope)

- **Real email vendor** — we ship the `EmailProvider` interface + a `LoggingEmailProvider` (logs the link). A real Resend/SMTP/SES impl is a later config swap. Public signup stays flag-gated OFF in prod until then.
- Billing, 2FA, SSO, magic-link login.
- Editable brand name / logo upload (unrelated Phase-2 follow-ups).

## Key decisions (settled in brainstorm)

- **Verify-then-create** for signup: a `PendingSignup` row holds the request until the emailed link is clicked; only then does the provisioning engine create the real tenant. Bots never mint tenants.
- **Password-reset links are only ever emailed/logged — never returned in an API response.** Returning them would let anyone reset anyone's password by calling the endpoint.
- **Invite links ARE returned to the authorizing owner** (in addition to being emailed/logged), so invites are usable even before a real email vendor exists (the owner copies/shares the link).
- **No email enumeration** on forgot-password: always a generic success response regardless of whether the email exists.
- Reuse the existing `ProvisioningService.provisionTenant({ createdVia: "SIGNUP" })` for the signup path — no new provisioning logic.

---

## Shared foundation

### EmailProvider seam
`apps/api/src/email/email.provider.ts` — an `EmailProvider` interface:
```
sendVerification(to, link): Promise<void>
sendPasswordReset(to, link): Promise<void>
sendInvite(to, link, restaurantName): Promise<void>
```
plus `LoggingEmailProvider` (logs `to` + `link`; mirrors the existing `NotificationProvider` seam in crm/loyalty). DI token `EMAIL_PROVIDER`, provided in a global `EmailModule`. A real vendor impl (Resend/SMTP/SES) is a drop-in later.

### Token foundation (one Prisma migration)
- **`PendingSignup`**: `id, email @unique, passwordHash, restaurantName, ownerName, tokenHash, expiresAt, createdAt`.
- **`AuthToken`**: `id, type (AuthTokenType: PASSWORD_RESET | INVITE), tenantId?, userId?, email?, roleId?, tokenHash, expiresAt, usedAt?, createdAt`. (`tenantId/roleId/email` used by invites; `userId` by reset.)
- All raw tokens are 32 random bytes (base64url); stored **hashed** (sha256); single-use (`usedAt` / row deletion); expiry (signup+invite 24h, reset 1h).
- A raw token only ever travels inside the emailed/returned link.

### Feature flag
`SIGNUP_PUBLIC_ENABLED` (default false; intended on only once a real `EmailProvider` is configured). When off, the public `/signup` + `/signup/verify` routes return 404/403. Password-reset and invites are NOT flag-gated (they're for existing users/tenants), but their delivery uses the same `EmailProvider` — with the logging impl, links are logged (reset) or returned (invite).

---

## Flow 1 — Public signup (flag-gated)

- `POST /signup` (`@Public`, tightly throttled): body `{ restaurantName, ownerName, email, password }`.
  - Reject if `email` already exists as a `User` or `PendingSignup` ("An account with this email already exists").
  - Create `PendingSignup` (hashed password + token), `emailProvider.sendVerification(email, ".../signup/verify?token=…")`.
  - Response `{ status: "verification_sent" }`.
- `POST /signup/verify` (`@Public`): body `{ token }`.
  - Look up by `tokenHash`, check expiry. Call `provisionTenant({ …, createdVia: "SIGNUP" })`, delete the `PendingSignup`, return `{ accessToken, user }` (auto-login → lands in onboarding).
- A lazy/scheduled sweep removes expired `PendingSignup` rows.

## Flow 2 — Password reset

- `POST /auth/forgot-password` (`@Public`, throttled): body `{ email }`.
  - If a user with that email exists, create an `AuthToken(PASSWORD_RESET, userId, 1h)` and `emailProvider.sendPasswordReset(email, ".../reset-password?token=…")`.
  - **Always** return `{ status: "ok" }` (no enumeration), whether or not the email existed.
- `POST /auth/reset-password` (`@Public`, throttled): body `{ token, newPassword }` (newPassword min 8).
  - Look up unused, unexpired `PASSWORD_RESET` token by hash → update the user's `passwordHash` (bcrypt 10) → mark `usedAt`. Return `{ status: "ok" }` (user then logs in normally).
  - The reset link/token is never exposed via any GET/response — only via the sent email.

## Flow 3 — Staff invites

- `GET /tenant/roles` (`@RequirePermission settings.manage`): list the tenant's roles (`{id, name}`) so the UI can pick one.
- `POST /tenant/invites` (`@RequirePermission settings.manage`): body `{ email, roleId }`.
  - Validate the role belongs to the caller's tenant (scoped read). Reject if the email is already an active user in the tenant.
  - Create `AuthToken(INVITE, tenantId, email, roleId, 24h)`, `emailProvider.sendInvite(email, link, restaurantName)`, and **return** `{ inviteLink }` to the owner.
- `POST /invite/accept` (`@Public`): body `{ token, name, password }`.
  - Look up unused/unexpired `INVITE` token → create the `User` (tenantId, roleId from the token, bcrypt password, emailVerified true, linked to the tenant's outlet(s)) → mark token used → return `{ accessToken, user }` (auto-login to their surface).
- Console gets an **Invite staff** screen (email + role picker + copyable link); this also realizes onboarding's deferred "invite staff" step.

---

## Frontend

Public (unauthenticated) pages in the dashboard app:
- `/signup` (+ a "verification sent — check your email" state) — only linked/enabled when `SIGNUP_PUBLIC_ENABLED`.
- `/signup/verify` — reads `?token`, calls verify, auto-logs-in → onboarding.
- `/forgot-password` and `/reset-password` (reads `?token`).
- `/invite/accept` (reads `?token`) — name + password → activate.

Authenticated:
- A **"Forgot password?"** link on `/login`.
- An **Invite staff** panel in Console (email + role + shows the returned invite link to copy).

All public pages mount outside the authed Shell (they're for logged-out users) and follow the existing styling.

## Security considerations

- Public routes (`/signup`, `/signup/verify`, `/auth/forgot-password`, `/auth/reset-password`, `/invite/accept`) are `@Public` + throttled (tight per-route limits on top of the global limiter).
- Tokens: 32 random bytes, hashed at rest, single-use, expiring (reset 1h; signup/invite 24h).
- Forgot-password never reveals whether an email exists.
- Reset tokens are never returned by any endpoint — only emailed.
- Invite creation is owner-gated (`settings.manage`); the invite binds `tenantId` + `roleId` server-side, so an accepted invite can only join the inviting tenant with the intended role.
- Signup verify + invite accept run the tenant/user creation **unscoped** where they create across/without a tenant context (signup uses the existing unscoped provisioning engine; invite-accept creates a user under the token's `tenantId`).

## Testing strategy

- **Backend (vitest harness + e2e):** signup (pending→verify→tenant created + auto-login; duplicate-email rejected; flag-off → routes blocked), password reset (happy path changes the hash; expired/used/invalid token rejected; forgot-password returns generic 200 for unknown email — no enumeration), invites (owner creates → accept creates the user with the right tenant+role; cross-tenant role rejected; used/expired token rejected; non-owner can't invite). Tests use `LoggingEmailProvider` and read the generated token from the captured link.
- **Frontend:** typecheck/build gate; the public flows verified end-to-end with the run skill (reading the logged verification/reset links in dev).

## Rollout

1. Email seam + token migration.
2. Password reset (smallest, highest-immediate-value; no flag).
3. Staff invites (owner-gated; link returned so usable now).
4. Public signup (flag-gated OFF until a vendor is configured).
5. Frontend pages for each.

## Open questions / to confirm during implementation

- Exact public-page mount pattern (the dashboard's authed Shell wraps most pages — confirm how to render logged-out routes; there may be an existing pattern from `/login`).
- Whether invite-accept links the new user to all tenant outlets or a chosen subset (default: all of the tenant's outlets, matching how provisioning links the owner).
- The base URL used to build emailed links (reuse the request origin / a `PUBLIC_APP_URL` env; confirm against how the app already derives its origin).
