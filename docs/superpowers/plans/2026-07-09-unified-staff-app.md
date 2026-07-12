# Unified Staff App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge POS, KDS, and Console into one Next.js staff app with a single login, where the caller's permissions decide which surface(s) they land on and can switch to.

**Architecture:** Grow `apps/dashboard` (Next.js App Router) into the unified app. A `SessionProvider` holds the auth token, `AuthUser`, and selected outlet. A pure `surfaceAccess(permissions)` helper (in `@stello/shared`) maps permissions → allowed surfaces + a primary. `/` is a role router that redirects to the user's primary surface; `/console`, `/pos`, `/kds` are the three surfaces under a shared `Shell` (top bar + surface switcher). POS and KDS port in as client React modules.

**Tech Stack:** Next.js 15 (App Router, client components), React 19, TypeScript, `@stello/shared` (Zod/DTOs + design tokens), Vitest (in `@stello/shared`), Socket.IO client (KDS).

## Global Constraints

- **Base branch:** `feat/unified-staff-app` (off `main`; the design spec is committed here).
- **Scope:** `apps/dashboard/**` and `packages/shared/**` (the `surfaceAccess` helper + test). The final phase also touches `deploy/**`. **No API, schema, auth, role, or permission changes.**
- **Do not touch** `apps/order` (diner) or `apps/edge` (offline) — out of scope.
- Surfaces are **client components** (`"use client"`) — they hold token/state/sockets in the browser.
- **One token key:** `stello.token` in `localStorage` (replacing `dash.token`/`pos.token`/`kds.token`).
- Reuse the existing `@stello/shared` types and the shared theme tokens; theming must keep working across all surfaces.
- Permission gate strings are the existing ones: `orders.settle` (POS), `kds.operate` (KDS), and any of `menu.manage`/`reports.view`/`inventory.manage`/`crm.manage`/`finance.manage`/`devices.manage` (Console); `*` means all.
- **Verify** each phase with `pnpm --filter @stello/shared test`, `pnpm --filter @stello/dashboard build`, and a browser check against the running stack (via the dev server or the deployed tunnel).

---

## Phase 1 — Shell + auth

### Task 1: `surfaceAccess` permission→surface helper (in `@stello/shared`, TDD)

**Files:**
- Create: `packages/shared/src/access.ts`
- Test: `packages/shared/src/access.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export)

**Interfaces:**
- Produces: `type Surface = "console" | "pos" | "kds"`; `interface SurfaceAccess { allowed: Surface[]; primary: Surface | null }`; `surfaceAccess(permissions: string[]): SurfaceAccess`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/access.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { surfaceAccess } from "./access";

describe("surfaceAccess", () => {
  it("owner (*) gets all three, primary console", () => {
    expect(surfaceAccess(["*"])).toEqual({ allowed: ["console", "pos", "kds"], primary: "console" });
  });
  it("cashier (orders.settle) → POS only", () => {
    expect(surfaceAccess(["orders.settle"])).toEqual({ allowed: ["pos"], primary: "pos" });
  });
  it("kitchen (kds.operate + menu.stock) → KDS only", () => {
    expect(surfaceAccess(["kds.operate", "menu.stock"])).toEqual({ allowed: ["kds"], primary: "kds" });
  });
  it("manager (reports.view) → Console only", () => {
    expect(surfaceAccess(["reports.view"])).toEqual({ allowed: ["console"], primary: "console" });
  });
  it("cashier+kitchen → both, primary pos (console>pos>kds order)", () => {
    expect(surfaceAccess(["orders.settle", "kds.operate"])).toEqual({ allowed: ["pos", "kds"], primary: "pos" });
  });
  it("no permissions → nothing", () => {
    expect(surfaceAccess([])).toEqual({ allowed: [], primary: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @stello/shared exec vitest run src/access.test.ts`
Expected: FAIL — cannot resolve `./access`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/access.ts`:

```ts
export type Surface = "console" | "pos" | "kds";

/** A surface is allowed if the user holds ANY of its gate permissions ("*" = all). */
const SURFACE_GATES: Record<Surface, string[]> = {
  console: ["menu.manage", "reports.view", "inventory.manage", "crm.manage", "finance.manage", "devices.manage"],
  pos: ["orders.settle"],
  kds: ["kds.operate"],
};

/** When several surfaces are allowed, this order picks the landing surface. */
const PRIMARY_ORDER: Surface[] = ["console", "pos", "kds"];

export interface SurfaceAccess {
  allowed: Surface[];
  primary: Surface | null;
}

export function surfaceAccess(permissions: string[]): SurfaceAccess {
  const has = (perm: string) => permissions.includes("*") || permissions.includes(perm);
  const allowed = (Object.keys(SURFACE_GATES) as Surface[]).filter((s) => SURFACE_GATES[s].some(has));
  const primary = PRIMARY_ORDER.find((s) => allowed.includes(s)) ?? null;
  return { allowed, primary };
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/shared/src/index.ts`, add alongside the other exports:

```ts
export * from "./access";
```

- [ ] **Step 5: Run the test to verify it passes + rebuild shared**

Run: `pnpm --filter @stello/shared exec vitest run src/access.test.ts` → PASS (6 tests).
Then: `pnpm --filter @stello/shared build` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/access.ts packages/shared/src/access.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): surfaceAccess helper — permissions to allowed staff surfaces"
```

---

### Task 2: Unify the auth token key in the dashboard API client

**Files:**
- Modify: `apps/dashboard/lib/api.ts` (lines 62, 67, 68)

**Interfaces:**
- Consumes: nothing new. Produces: same `api`, `setToken`, `hasToken`, now keyed on `stello.token`.

- [ ] **Step 1: Change the storage key to the shared one**

In `apps/dashboard/lib/api.ts`, replace the three `"dash.token"` literals with `"stello.token"`:

```ts
let token: string | null = typeof window !== "undefined" ? localStorage.getItem("stello.token") : null;
// …
if (t) localStorage.setItem("stello.token", t);
else localStorage.removeItem("stello.token");
```

- [ ] **Step 2: Build to confirm no breakage**

Run: `pnpm --filter @stello/dashboard build`
Expected: succeeds. (Existing users will simply re-log in once — acceptable per the spec.)

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/lib/api.ts
git commit -m "refactor(console): use the shared stello.token auth key"
```

---

### Task 3: `SessionProvider` — global auth + outlet state

**Files:**
- Create: `apps/dashboard/components/SessionProvider.tsx`
- Modify: `apps/dashboard/app/layout.tsx` (wrap children)

**Interfaces:**
- Consumes: `api`, `hasToken`, `setToken` (`@/lib/api`); `AuthUser`, `OutletDto` (`@stello/shared`).
- Produces: `useSession(): { user, outlets, outlet, loading, setOutlet, login, logout, refresh }`.

- [ ] **Step 1: Create the provider**

Create `apps/dashboard/components/SessionProvider.tsx`:

```tsx
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AuthUser, OutletDto } from "@stello/shared";
import { api, hasToken, setToken } from "@/lib/api";

interface Session {
  user: AuthUser | null;
  outlets: OutletDto[];
  outlet: OutletDto | null;
  loading: boolean;
  setOutlet: (o: OutletDto | null) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession must be used within <SessionProvider>");
  return c;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [outlets, setOutlets] = useState<OutletDto[]>([]);
  const [outlet, setOutlet] = useState<OutletDto | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([api.me(), api.outlets()]);
      setUser(me);
      setOutlets(list);
      setOutlet((prev) => prev ?? (list.length === 1 ? list[0] : null));
    } catch {
      setToken(null);
      setUser(null);
      setOutlets([]);
      setOutlet(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasToken()) void refresh();
    else setLoading(false);
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.login(email, password);
      setToken(res.accessToken);
      setLoading(true);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setOutlets([]);
    setOutlet(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, outlets, outlet, loading, setOutlet, login, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
}
```

- [ ] **Step 2: Wrap the app in the provider**

In `apps/dashboard/app/layout.tsx`, import and wrap the `{children}` in the `<body>` with `<SessionProvider>`:

```tsx
import { SessionProvider } from "@/components/SessionProvider";
// … inside <body>:
<SessionProvider>{children}</SessionProvider>
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @stello/dashboard build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/components/SessionProvider.tsx apps/dashboard/app/layout.tsx
git commit -m "feat(console): SessionProvider for global auth + outlet state"
```

---

### Task 4: `/login` route + `/` role router

**Files:**
- Create: `apps/dashboard/app/login/page.tsx`
- Rewrite: `apps/dashboard/app/page.tsx` (now a role router)

**Interfaces:**
- Consumes: `useSession` (Task 3); `surfaceAccess` (`@stello/shared`); `useRouter` (`next/navigation`).
- Produces: routing behaviour — unauthenticated → `/login`; authenticated → redirect to `surfaceAccess(user.permissions).primary`.

- [ ] **Step 1: Create the login page**

Create `apps/dashboard/app/login/page.tsx` (extracted from the current inline `Login` in `page.tsx`; uses `useSession().login`):

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/SessionProvider";

export default function LoginPage() {
  const { user, loading, login } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("admin@demo.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="wordmark">STELLO KITCHENS</span>
        <h1>Sign in</h1>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn-primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="login-hint">Demo: admin@demo.com / password123</p>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Replace `app/page.tsx` with the role router**

Rewrite `apps/dashboard/app/page.tsx` entirely:

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { surfaceAccess } from "@stello/shared";
import { useSession } from "@/components/SessionProvider";

export default function Home() {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    const { primary } = surfaceAccess(user.permissions);
    router.replace(primary ? `/${primary}` : "/no-access");
  }, [user, loading, router]);

  return <div className="boot">Loading…</div>;
}
```

- [ ] **Step 3: Add a minimal `/no-access` page**

Create `apps/dashboard/app/no-access/page.tsx`:

```tsx
"use client";
import { useSession } from "@/components/SessionProvider";

export default function NoAccess() {
  const { user, logout } = useSession();
  return (
    <div className="boot" style={{ flexDirection: "column", gap: 12 }}>
      <p>No staff surface is available for {user?.roleName ?? "this role"}.</p>
      <button className="text-btn" onClick={logout}>Sign out</button>
    </div>
  );
}
```

- [ ] **Step 4: Build + manual check**

Run: `pnpm --filter @stello/dashboard build` → succeeds.
Then `pnpm --filter @stello/dashboard dev` (with the API reachable): visiting `/` unauthenticated redirects to `/login`; logging in as `admin@demo.com` redirects toward `/console` (which 404s until Task 5 — expected at this step).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/app/login/page.tsx apps/dashboard/app/page.tsx apps/dashboard/app/no-access/page.tsx
git commit -m "feat(console): unified login + permission-based role router"
```

---

### Task 5: Shared `Shell` (top bar + surface switcher) and the `/console` route

**Files:**
- Create: `apps/dashboard/components/Shell.tsx`
- Create: `apps/dashboard/app/console/page.tsx`
- Modify: `apps/dashboard/components/Console.tsx` (drop its own login/outlet-pick chrome; accept it from Shell)

**Interfaces:**
- Consumes: `useSession` (Task 3); `surfaceAccess`, `Surface` (`@stello/shared`); `ThemeProvider` (`@/components/ThemeProvider`).
- Produces: `<Shell surface={Surface}>…</Shell>` — guards auth + permission + outlet selection, renders the top bar, and themes its children.

- [ ] **Step 1: Create the Shell**

Create `apps/dashboard/components/Shell.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { surfaceAccess, type Surface } from "@stello/shared";
import { useSession } from "@/components/SessionProvider";
import { ThemeProvider } from "@/components/ThemeProvider";

const LABEL: Record<Surface, string> = { console: "Console", pos: "POS", kds: "KDS" };

export function Shell({ surface, children }: { surface: Surface; children: React.ReactNode }) {
  const { user, loading, outlets, outlet, setOutlet, logout } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const access = user ? surfaceAccess(user.permissions) : { allowed: [], primary: null };

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    else if (!access.allowed.includes(surface)) router.replace("/");
  }, [loading, user, surface, router, access.allowed]);

  if (loading || !user) return <div className="boot">Loading…</div>;
  if (!access.allowed.includes(surface)) return <div className="boot">Redirecting…</div>;

  // Outlet selection is shared across surfaces: pick once, all surfaces use it.
  if (!outlet) {
    return (
      <ThemeProvider>
        <div className="pick-outlet">
          <span className="wordmark">STELLO KITCHENS</span>
          <h1>Select outlet</h1>
          <div className="outlet-list">
            {outlets.map((o) => (
              <button key={o.id} className="outlet-card" onClick={() => setOutlet(o)}>
                <span className="outlet-brand">{o.brandName}</span>
                <span className="outlet-name">{o.name}</span>
                <span className="outlet-addr">{o.address}</span>
              </button>
            ))}
            {outlets.length === 0 && <p>No outlets assigned.</p>}
          </div>
          <button className="text-btn" onClick={logout}>Sign out</button>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider themeId={outlet.themeId}>
      <div className="shell">
        <header className="shell-bar">
          <span className="wordmark">STELLO KITCHENS</span>
          {access.allowed.length > 1 && (
            <nav className="surface-switch">
              {access.allowed.map((s) => (
                <button
                  key={s}
                  className={pathname?.startsWith(`/${s}`) ? "active" : ""}
                  onClick={() => router.push(`/${s}`)}
                >
                  {LABEL[s]}
                </button>
              ))}
            </nav>
          )}
          <div className="shell-right">
            <span className="shell-outlet">{outlet.name}{outlets.length > 1 ? "" : ""}</span>
            {outlets.length > 1 && (
              <button className="text-btn" onClick={() => setOutlet(null)}>Switch outlet</button>
            )}
            <span className="shell-user">{user.name}</span>
            <button className="text-btn" onClick={logout}>Sign out</button>
          </div>
        </header>
        <main className="shell-body">{children}</main>
      </div>
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Add Shell styles**

Append to `apps/dashboard/app/globals.css` (token-driven so it themes):

```css
.shell { min-height: 100vh; display: flex; flex-direction: column; }
.shell-bar { display: flex; align-items: center; gap: 20px; padding: 10px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
.shell-bar .wordmark { font-weight: 800; letter-spacing: .06em; color: var(--accent); }
.surface-switch { display: flex; gap: 4px; }
.surface-switch button { padding: 7px 14px; border-radius: var(--radius-sm); border: 1px solid transparent; background: transparent; color: var(--muted); font-weight: 600; cursor: pointer; }
.surface-switch button.active { background: var(--accent-soft); color: var(--ink); border-color: var(--line); }
.shell-right { margin-left: auto; display: flex; align-items: center; gap: 14px; color: var(--muted); font-size: 14px; }
.shell-user { color: var(--ink); font-weight: 600; }
.shell-body { flex: 1; min-height: 0; }
```

- [ ] **Step 3: Slim the Console chrome**

In `apps/dashboard/components/Console.tsx`, the top-of-Console sign-out / switch-outlet controls now live in `Shell`. Remove those controls from Console's own header (keep everything else — tabs and content). Change its props type so `onSwitchOutlet` and `onLogout` are optional and unused, or remove them from the signature and its call site. Keep `user` and `outlet` props (the tabs use them).

- [ ] **Step 4: Create the `/console` route**

Create `apps/dashboard/app/console/page.tsx`:

```tsx
"use client";

import { Shell } from "@/components/Shell";
import { Console } from "@/components/Console";
import { useSession } from "@/components/SessionProvider";

export default function ConsolePage() {
  const { user, outlet } = useSession();
  return (
    <Shell surface="console">
      {user && outlet && <Console user={user} outlet={outlet} />}
    </Shell>
  );
}
```

- [ ] **Step 5: Build + browser check across roles**

Run: `pnpm --filter @stello/dashboard build` → succeeds.
With the API up, `pnpm --filter @stello/dashboard dev`:
- Log in as `admin@demo.com` → lands on `/console`, Console renders, no switcher visible yet beyond Console (POS/KDS routes come next), outlet picker works with 2 outlets, sign-out works.
- Confirm the top bar themes with the brand theme (switch theme in Appearance and reload).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/components/Shell.tsx apps/dashboard/app/console/page.tsx apps/dashboard/components/Console.tsx apps/dashboard/app/globals.css
git commit -m "feat(console): shared shell with surface switcher; move Console under /console"
```

---

## Phase 2 — Port POS

### Task 6: POS as the `/pos` route

**Files:**
- Create: `apps/dashboard/components/pos/` — copies of `apps/pos/src/{App,Billing,CashDrawer,ComboDialog,ItemDialog,SettleDialog}.tsx`
- Create: `apps/dashboard/components/pos/pos.css` (from `apps/pos/src/styles.css`)
- Create: `apps/dashboard/lib/pos-api.ts` (POS-specific endpoints from `apps/pos/src/api.ts`, minus token/login plumbing)
- Create: `apps/dashboard/app/pos/page.tsx`

**Interfaces:**
- Consumes: `useSession` (for `user`, `outlet`); the shared `request`/token from `@/lib/api`; `Shell`.
- Produces: a working POS at `/pos`, gated by `orders.settle`.

- [ ] **Step 1: Port the POS API calls onto the shared client**

Open `apps/pos/src/api.ts`. It has the same `request`/`setToken`/`hasToken` plumbing as the dashboard plus POS-specific methods (orders, KOT, settle, cash, combos). Create `apps/dashboard/lib/pos-api.ts` that **imports the shared `request`** — extract just the POS method object. Concretely: export a `posApi` object whose methods mirror `apps/pos/src/api.ts`'s methods but call the dashboard's shared `request` (add a small `export function request` to `@/lib/api` if it is not already exported, or re-declare the fetch wrapper once and have both `api` and `posApi` use it). Do **not** duplicate token handling — the shared client already owns `stello.token`.

- [ ] **Step 2: Copy the POS components and repoint imports**

Copy the six POS component files into `apps/dashboard/components/pos/`. In each:
- add `"use client";` at the top if missing,
- change `import … from "./api"` → `import { posApi as api } from "@/lib/pos-api"`,
- remove the `import { ThemeProvider } from "./ThemeProvider"` and any `<ThemeProvider>` wrapper (the Shell themes now),
- delete the in-component **Login** screen and the outlet-picker from `App.tsx` (auth + outlet come from the Shell/session); `App` should accept `{ user, outlet }` props and render straight into the billing UI.

- [ ] **Step 3: Scope the POS stylesheet**

Copy `apps/pos/src/styles.css` → `apps/dashboard/components/pos/pos.css`. Prefix its selectors so they cannot collide with Console/KDS: wrap by nesting every rule under a `.pos-root` scope (e.g. add a leading `.pos-root ` to each selector, or wrap in `@scope (.pos-root)` if targeting is simple). Import it from the POS `App` and render the POS tree inside `<div className="pos-root">`.

- [ ] **Step 4: Create the `/pos` route**

Create `apps/dashboard/app/pos/page.tsx`:

```tsx
"use client";

import { Shell } from "@/components/Shell";
import { App as Pos } from "@/components/pos/App";
import { useSession } from "@/components/SessionProvider";

export default function PosPage() {
  const { user, outlet } = useSession();
  return (
    <Shell surface="pos">
      {user && outlet && <Pos user={user} outlet={outlet} />}
    </Shell>
  );
}
```

- [ ] **Step 5: Build + drive the POS end-to-end**

Run: `pnpm --filter @stello/dashboard build` → succeeds (fix any type errors from the port).
With the API up and dev server running, log in as `cashier@demo.com` → lands directly on `/pos` (no switcher, per permissions). Punch items, send a KOT, open the settle dialog, split a payment, and settle. Confirm a bill number is assigned and the running-bill/cash-drawer widgets work. Log in as `admin@demo.com` and confirm the switcher now offers Console | POS and POS works there too.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/components/pos apps/dashboard/lib/pos-api.ts apps/dashboard/app/pos/page.tsx apps/dashboard/lib/api.ts
git commit -m "feat(console): port the POS surface to /pos (gated by orders.settle)"
```

---

## Phase 3 — Port KDS (+ wall mode)

### Task 7: KDS as the `/kds` route with a chrome-free wall mode

**Files:**
- Create: `apps/dashboard/components/kds/{App,Board}.tsx` (from `apps/kds/src/`)
- Create: `apps/dashboard/components/kds/kds.css` (scoped, from `apps/kds/src/styles.css`)
- Create: `apps/dashboard/lib/kds-api.ts` (KDS endpoints on the shared client)
- Create: `apps/dashboard/app/kds/page.tsx`

**Interfaces:**
- Consumes: `useSession`; shared `request`; `Shell`; `useSearchParams` (`next/navigation`); `socket.io-client`.
- Produces: KDS at `/kds` (gated by `kds.operate`); `/kds?display=wall` renders full-screen with no shell chrome.

- [ ] **Step 1: Add the Socket.IO client dependency to the dashboard**

The KDS board holds a live socket. Add `socket.io-client` to `apps/dashboard/package.json` dependencies (match the version in `apps/kds/package.json`). Run `pnpm install`.

- [ ] **Step 2: Port the KDS API + board**

Create `apps/dashboard/lib/kds-api.ts` mirroring `apps/kds/src/api.ts`'s methods on the shared `request` (no token duplication). Copy `App.tsx`/`Board.tsx` into `apps/dashboard/components/kds/`, add `"use client";`, repoint `./api` → `@/lib/kds-api`, drop the local `ThemeProvider` and the in-component Login/outlet-pick (KDS uses the session's outlet). `App` accepts `{ user, outlet }` and renders the board. The `io(...)` connection stays client-side and connects same-origin (`io({ path: "/socket.io" })`) exactly as today.

- [ ] **Step 3: Scope the KDS stylesheet**

Copy `apps/kds/src/styles.css` → `apps/dashboard/components/kds/kds.css`, scoping every selector under `.kds-root` (same technique as POS). Render the board inside `<div className="kds-root">`.

- [ ] **Step 4: Create the `/kds` route with wall mode**

Create `apps/dashboard/app/kds/page.tsx`:

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { App as Kds } from "@/components/kds/App";
import { useSession } from "@/components/SessionProvider";

export default function KdsPage() {
  const wall = useSearchParams().get("display") === "wall";
  const { user, outlet } = useSession();
  const board = user && outlet ? <Kds user={user} outlet={outlet} /> : null;
  // Wall mode: full-screen board, no shell chrome (for a dedicated kitchen screen).
  if (wall) return <div className="kds-wall">{board}</div>;
  return <Shell surface="kds">{board}</Shell>;
}
```

Note: wall mode still needs auth + the outlet. Add a light guard inside the `wall` branch: if `!user` redirect to `/login`; if `!outlet` render the same outlet picker Shell uses (extract Shell's picker into a small shared `OutletPicker` component and reuse it here) so a kitchen screen can log in and pick its outlet once, then stays on the wall. Add `.kds-wall { height: 100vh; }` to `globals.css`.

- [ ] **Step 5: Build + verify both modes**

Run: `pnpm --filter @stello/dashboard build` → succeeds.
With the API + a POS able to fire KOTs: log in as `kitchen@demo.com` → lands on `/kds`; punch a KOT from POS (other tab) and confirm it appears within ~2s (socket) and ages green→amber→red; advance a ticket. Then open `/kds?display=wall` → board fills the screen with no top bar and keeps updating.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/components/kds apps/dashboard/lib/kds-api.ts apps/dashboard/app/kds/page.tsx apps/dashboard/app/globals.css apps/dashboard/package.json pnpm-lock.yaml
git commit -m "feat(console): port the KDS surface to /kds with a full-screen wall mode"
```

---

## Phase 4 — Deploy alongside, then retire the old apps

### Task 8: Deploy the unified app alongside the three current ones

**Files:**
- Modify: `deploy/docker-compose.prod.yml` (add a `console`/unified service on a new port; it is the existing `dashboard` image, already built — so this is a rename/confirm, since `dashboard` now *is* the unified app)
- Modify: `deploy/nginx-host.conf.example` (add an `app.` vhost → the unified app port)
- Modify: `deploy/README-DEPLOY.md` (subdomain/port table)

**Interfaces:**
- Consumes: the built dashboard image (which now serves POS/KDS/Console). Produces: the unified app reachable on its own port/subdomain, with `pos`/`kds` still running separately for validation.

- [ ] **Step 1: Expose the unified app on its own port**

Because the unified app *is* the grown `dashboard`, it already deploys as the `dashboard` service on `127.0.0.1:18082`. Add an `app.` alias in `deploy/nginx-host.conf.example` pointing at `127.0.0.1:18082` (a `server { server_name app.example.com; … proxy_pass http://127.0.0.1:18082; }` block, mirroring the `admin.` block). Keep the `pos`/`kds` services and their vhosts for now.

- [ ] **Step 2: Rebuild + redeploy on the server**

From the deployed checkout (`/webserver/vansh/stello-kitchen`), re-sync the code and run `./deploy/deploy.sh` (rebuilds `stello-build`, recreates `dashboard`). Verify `http://127.0.0.1:18082` now serves the login → role-routed unified app.

- [ ] **Step 3: Validate all three surfaces through one login**

Via the tunnel or `app.` subdomain: log in as owner → Console + switcher to POS/KDS; as cashier → POS; as kitchen → KDS (+ `?display=wall`). Confirm parity with the standalone apps.

- [ ] **Step 4: Commit**

```bash
git add deploy/nginx-host.conf.example deploy/README-DEPLOY.md
git commit -m "chore(deploy): expose the unified staff app on the app. subdomain"
```

---

### Task 9: Retire the standalone POS/KDS (and dead code)

**Files:**
- Modify: `deploy/docker-compose.prod.yml` (remove the `pos` and `kds` services + their ports)
- Modify: `deploy/nginx-host.conf.example`, `deploy/README-DEPLOY.md` (drop `pos.`/`kds.`)
- Delete: `apps/pos`, `apps/kds` (now superseded by the `/pos` and `/kds` routes) — only after validation
- Modify: `pnpm-workspace.yaml` if it lists apps explicitly; `deploy/Dockerfile.build` (drop the `@stello/pos`/`@stello/kds` build filters, keep `dashboard`)

**Interfaces:**
- Consumes: a validated unified app (Task 8). Produces: staff surfaces served only by the unified app; `pos.`/`kds.` subdomains retired.

- [ ] **Step 1: Remove the standalone services from the stack**

In `deploy/docker-compose.prod.yml`, delete the `pos:` and `kds:` service blocks (and their `18083`/`18084` ports). In `deploy/Dockerfile.build`, remove the `--filter "@stello/pos..."` and `--filter "@stello/kds..."` install/build lines. Update `deploy/nginx-host.conf.example` and `deploy/README-DEPLOY.md` to drop the `pos.`/`kds.` rows, leaving `api.`, `app.`, `order.`, `connector.`.

- [ ] **Step 2: Delete the superseded app source**

Remove `apps/pos/` and `apps/kds/` (their code now lives under `apps/dashboard/components/{pos,kds}`). Run `pnpm install` to refresh the lockfile.

- [ ] **Step 3: Rebuild + redeploy + final validation**

Re-sync and `./deploy/deploy.sh`. Confirm `docker compose ps` no longer lists `pos`/`kds`, and that the unified app still serves all three surfaces. Confirm the diner `order` app and `api`/`connector` are unaffected.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(deploy): retire standalone POS/KDS; unified app serves all staff surfaces"
```

---

## Definition of Done

- One login (`stello.token`); `GET /auth/me` → `surfaceAccess` routes cashier→POS, kitchen→KDS, owner→Console with a working surface switcher across the allowed surfaces.
- `/pos`, `/kds` (incl. `?display=wall`), and `/console` all function inside `apps/dashboard`, still themed from brand tokens; the KDS live socket + ageing work.
- Deployed alongside the old apps, validated, then `pos`/`kds` retired — staff surfaces reduced to the single `app.` subdomain.
- Scope stayed within `apps/dashboard/**`, `packages/shared/**` (the `surfaceAccess` helper), and `deploy/**`. No API/schema/permission changes; `apps/order` and `apps/edge` untouched.
