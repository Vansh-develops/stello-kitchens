# Unified Staff App — Design

## 1. Goal

Replace the three separate staff frontends — POS (`apps/pos`), KDS (`apps/kds`), and Console (`apps/dashboard`) — with **one app** that a staff member logs into once and which shows the right surface(s) based on their role/permissions. The backend already models this ("distributed by credentials"): one user → one role → a permission list, exposed at `GET /auth/me`. This project consolidates only the **frontend**; no API or data-model change is required.

End state: a staff member logs in once and lands on their surface (cashier → POS, kitchen → KDS, owner → Console), switching between surfaces only where their permissions allow.

## 2. Non-goals (YAGNI)

- The diner **Scan & Order** app (`apps/order`) stays separate — it is public, token-based, and customer-facing, with no login.
- The **Edge** terminal (`apps/edge`) stays separate — it is an offline-first Electron client.
- No changes to the API, auth model, roles, permissions, or database.
- No new permissions or role types. We consume the existing ones.
- No redesign of the individual surfaces' internals — this is consolidation, not a UX rework. (Targeted cleanups where a merge requires them are in scope.)

## 3. Architecture

Grow the existing Next.js app (`apps/dashboard`, renamed conceptually to the "console"/unified app) into a single frontend hosting all three staff surfaces under a shared shell, gated by the caller's permissions. POS and KDS port in as **client React modules** — their logic is framework-agnostic React, so this is copy-in + swapping their local `api.ts`/`ThemeProvider` for the app's shared ones, not a rewrite.

```
apps/dashboard  (Next.js App Router — the unified staff app)
├─ /login                 single login (email + password)
├─ /                      role router → redirect to the user's primary surface
├─ /pos                   POS module        (gate: orders.settle)
├─ /kds                   KDS module        (gate: kds.operate)     + wall mode
├─ /console/…             back office        (gate: menu.manage / reports.view / …)
└─ shared shell           top bar: brand · surface switcher · user · sign out
```

The three surfaces continue to use `@stello/shared` (types, schemas) and the shared theme tokens they already share, so **brand theming keeps working** across the unified app.

## 4. Auth & role flow (the core mechanism)

- **One token, one storage key** — `stello.token` in `localStorage`, replacing the three near-identical per-app keys (`pos.token` / `kds.token` / `dash.token`). One shared `lib/api.ts` (consolidated from the three existing copies, which already share shape: Bearer header, 401 → clear token).
- On load: no token → redirect to `/login`. After login, call **`GET /auth/me`** to get the user's role + permission list.
- A pure helper **`surfaceAccess(permissions): { allowed: Surface[]; primary: Surface }`** maps permissions → allowed surfaces and a primary:
  - `orders.settle` → POS · `kds.operate` → KDS · any of `menu.manage` / `reports.view` / `inventory.manage` / `crm.manage` / `finance.manage` / `devices.manage` → Console.
  - Owner (`*`) → all three; primary = Console.
  - Primary selection order when multiple apply: Console > POS > KDS (owners/managers land in the back office; a cashier with only `orders.settle` lands in POS).
- `/` reads `surfaceAccess` and redirects to `primary`. Visiting a surface the user lacks permission for shows a brief "not available for your role" and redirects to their primary.
- The **surface switcher** in the top bar renders only `allowed` surfaces — a cashier sees POS with no switcher; an owner sees Console | POS | KDS.

## 5. How each surface ports in

- **POS** → `apps/dashboard/app/pos/` — the current `apps/pos/src/App.tsx` tree (outlet pick, menu grid, running bill, KOT, settle/combo/cash dialogs) minus its own login screen (auth is global now). Its `styles.css` moves in as a scoped stylesheet; `api.ts` calls route through the shared client.
- **KDS** → `apps/dashboard/app/kds/` — the board, station tabs, ageing timers, and the Socket.IO client. **Wall mode**: a `display=wall` flag (`/kds?display=wall`) renders the board full-screen with the shared shell/top-bar hidden and its own resilient auto-refresh, so a dedicated kitchen screen logs in once and stays on the wall.
- **Console** → already in this app; it moves under the shared shell + switcher (its existing tabs are unchanged).
- Duplicate utilities (the three `api.ts`, the three `ThemeProvider.tsx`) collapse to one shared copy each.

## 6. Deployment / migration

Build the unified app **alongside** the existing three so nothing breaks during the transition:

1. Develop and deploy the unified app as a new service (e.g. `app.` / host port `18087`) next to the current `pos`/`kds`/`dashboard` services.
2. Validate that POS, KDS, and Console all work through one login on the unified app.
3. **Then retire** `pos`, `kds`, and `dashboard` from the production compose stack.

End state collapses the staff surfaces from six deployables to **three subdomains**: `app.` (unified staff) + `api.` + `order.` (diners). No hard cutover; the old apps keep serving until the unified app is validated.

## 7. Build phases (each a working, mergeable increment)

1. **Shell + auth** — unified `/login`, `GET /auth/me`, `surfaceAccess`, the `/` role router, and the top-bar shell + surface switcher, with Console as the first mounted surface. Consolidate to one `lib/api.ts` and one `ThemeProvider`.
2. **Port POS** as `/pos` (gated by `orders.settle`), styles scoped, auth global.
3. **Port KDS** as `/kds` (gated by `kds.operate`) + `display=wall` full-screen mode.
4. **Deploy alongside → validate → retire** the three old apps from the stack; update the deploy config and subdomain map.

## 8. Risks & mitigations

- **CSS collisions between ported surfaces** — POS/KDS/Console each bring their own stylesheets. Mitigate by scoping each surface's styles to its route (CSS Modules or a route-scoped class prefix); the shared design tokens stay global.
- **KDS Socket.IO under Next.js** — the KDS board holds a live socket. It runs client-side only (`"use client"`), same as today; the wall mode keeps the existing poll fallback for resilience.
- **Session/token unification** — moving three keys to one means users re-authenticate once after the switch; acceptable and expected.
- **Regression risk during merge** — mitigated by the build-alongside migration: the old apps keep running until the unified app is validated in production.

## 9. Definition of done

- One app, one login. `GET /auth/me` drives a permission-based router: cashier → POS, kitchen → KDS, owner → Console with a working surface switcher across all three.
- POS, KDS (incl. wall mode), and Console all function inside the unified app, still themed from brand tokens.
- Deployed alongside the existing apps and validated; a follow-up retires the three old services, reducing staff surfaces to a single `app.` subdomain.
- Scope stayed in the frontend: `apps/dashboard/**` (plus the deploy config in the final phase). No API/schema changes.
