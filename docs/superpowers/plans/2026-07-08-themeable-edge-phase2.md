# Themeable Edge (offline terminal) — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the offline-first Edge terminal (`apps/edge`) follow the brand's selected theme, so a store billing offline renders in the same brand look as POS/KDS/Console/Scan & Order — and keeps that look even with the WAN down.

**Architecture:** The Edge renderer talks *only* to the local master service (the sidecar) — never the cloud — so it works identically online and offline. The theme therefore cannot be fetched fresh from the API at render time; it must ride along on the **cached reference snapshot**. The `/sync/snapshot` response already carries `themeId` (added in Phase 1; `SyncSnapshotDto.themeId`, populated by `apps/api/src/sync/sync.service.ts:88`). The sidecar caches that snapshot at bootstrap and on every sync but currently **drops `themeId`** — so the work is: persist `themeId` into the device's SQLite `meta`, surface it on `/status`, and have the renderer apply it via the same client `ThemeProvider` pattern used by the other apps. Then remap `apps/edge/src/styles.css` onto the shared design tokens.

**Tech Stack:** React + Vite (Electron renderer SPA), a Node/Express + better-sqlite3 sidecar (`apps/edge/sidecar/*`, plain CommonJS), TypeScript, `@stello/shared`.

## Global Constraints

- **Base branch:** Phase 1 + KDS + Console + Order are all merged to `main`, so branch off `main` (`@stello/shared` theme registry, `Brand.themeId`, `SyncSnapshotDto.themeId`, and `tailwind.preset.cjs` are all present).
- Scope: `apps/edge/**` only. **No API change is required** — the snapshot already carries `themeId`. Do NOT modify the theme registry, other apps, the API, or the root `tailwind.preset.cjs`.
- Token names are those in `REQUIRED_TOKENS` (`packages/shared/src/theme.ts`). The `:root` shared-token defaults equal the `counter` theme (identical block used by POS/KDS/Console/Order).
- The sidecar/engine is **CommonJS** (`require`, no TS). Keep it that way — no ESM, no TypeScript in `sidecar/*`.
- **`--ink` collision:** like the Console/Order, the edge app defines `--ink` (`#14110f`) and uses it as a **background**; the shared `--ink` token is **text**. Background usages of `var(--ink)` must move to `var(--bg)`. Edge's text colour is `--cream` → remap to `--ink`.
- `ThemeProvider` mirrors the KDS/Order provider verbatim (React client component). Edge has no Tailwind and theming is variable-only, so do NOT add Tailwind; the shared preset is not used here.
- Soft tints/glows follow the repo convention: `color-mix(in srgb, var(--token) X%, transparent)` (as in `apps/order/src/styles.css`, `apps/kds/src/styles.css`). Keep `999px` pills and `50%` circles literal.
- Verify with `pnpm --filter @stello/edge build` + a hardcoded-hex grep gate + an offline render check across ≥2 light and ≥2 dark themes.

## Palette remap (edge app)

| edge var | current | → shared token | notes |
| --- | --- | --- | --- |
| `--ink` | `#14110f` (background) | `--bg` | migrate `var(--ink)` background usages → `var(--bg)`; remove `--ink` def (collides with shared text token). |
| `--slate` | `#1d1a17` | `--panel` | raised surface (connect-card, cat hover). |
| `--slate-2` | `#262220` | `--panel-2` | raised surface-2 (item cards, buttons, active chip). |
| `--cream` | `#f4ede2` (text) | `--ink` | edge body text → shared ink. |
| `--line` | `#363029` | `--line` | same name — theme-driven; keep only as counter default. |
| `--muted` | `#a1968a` | `--muted` | same name. |
| `--faint` | `#6f665c` | `--faint` | same name. |
| `--saffron` | `#f5a623` | `--accent` | primary accent. |
| `--saffron-deep` | `#d98613` | `--accent` | hover border — collapses onto accent. |
| `--chili` | `#e2542a` | `--crit` | danger / offline. |
| `--leaf` | `#57a55a` | `--veg` | veg indicator. |
| `--mint` | `#2dd4a7` | `--good` | online / synced positive. |
| `#241a08` | accent-button text | `--accent-ink` | on-accent foreground. |
| `--sans`, `--mono` | fonts | (unchanged) | keep the terminal type identity (fonts out of scope, per Console/Order). |

---

### Task 1: Persist & expose `themeId` through the Edge sidecar

**Files:**
- Modify: `apps/edge/sidecar/engine.js` (`cacheSnapshot`, `status`)
- Modify: `apps/edge/src/api.ts` (`EdgeStatus`)

**Interfaces:**
- Consumes: `SyncSnapshotDto.themeId` (Phase 1) from `/sync/snapshot`.
- Produces: `themeId` persisted in `meta`, returned on `GET /status`; `EdgeStatus.themeId: string | null`.

- [ ] **Step 1: Persist the snapshot's themeId**

In `apps/edge/sidecar/engine.js`, `cacheSnapshot(snapshot)` currently stores `snapshot.menu` and `snapshot.areas` and stamps `snapshotAt`. Add: `this._setMeta("themeId", snapshot.themeId || "");` (guard against an older cache/snapshot without the field). This runs on both bootstrap and every sync, so the cached theme refreshes when the owner changes it in Console.

- [ ] **Step 2: Return themeId from status()**

In `engine.status()`, add `themeId: this._meta("themeId") || null,` to the returned object. `/status` in `server.js` already spreads `engine.status()`, so no server change is needed.

- [ ] **Step 3: Add themeId to the renderer's EdgeStatus type**

In `apps/edge/src/api.ts`, add `themeId: string | null;` to the `EdgeStatus` interface.

- [ ] **Step 4: Commit**

```bash
git add apps/edge/sidecar/engine.js apps/edge/src/api.ts
git commit -m "feat(edge): cache the brand themeId from the sync snapshot and expose it on /status"
```

---

### Task 2: Edge ThemeProvider + wiring + Vite interop

**Files:**
- Create: `apps/edge/src/ThemeProvider.tsx`
- Modify: `apps/edge/src/App.tsx`
- Modify: `apps/edge/vite.config.ts`

**Interfaces:**
- Consumes: `applyTheme`, `getTheme`, `DEFAULT_THEME_ID` (`@stello/shared`); `EdgeStatus.themeId` (Task 1).
- Produces: `<ThemeProvider themeId={...}>` applying tokens to `document.documentElement`.

- [ ] **Step 1: Create the provider** (identical to the KDS/Order provider)

```tsx
import { useEffect } from "react";
import { applyTheme, getTheme, DEFAULT_THEME_ID } from "@stello/shared";

export function ThemeProvider({ themeId, children }: { themeId?: string; children: React.ReactNode }) {
  useEffect(() => {
    applyTheme(getTheme(themeId ?? DEFAULT_THEME_ID), document.documentElement);
  }, [themeId]);
  return <>{children}</>;
}
```

- [ ] **Step 2: Wrap every render branch in App.tsx**

`App.tsx` has three early returns (boot spinner, connect screen, main terminal). Import the provider and wrap **all** returned trees in `<ThemeProvider themeId={status?.themeId ?? undefined}>` so the theme applies on the connect screen too (the sidecar knows the outlet/theme even before the renderer shows the terminal). Before `status` loads, `themeId` is undefined → default `counter`. Convert `null` to `undefined` at the prop boundary (the provider takes `themeId?: string`). Do not change any other logic or markup.

- [ ] **Step 3: Vite CJS-interop + dev-server optimizeDeps**

`@stello/shared` is a pnpm-symlinked CommonJS package. Mirror the Order fix — widen Rollup's commonjs interop (production build) and pre-bundle for the dev server — while preserving the existing `base: "./"` and `server: { port: 5175 }`:

```ts
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { commonjsOptions: { include: [/node_modules/, /packages\/shared/] } },
  optimizeDeps: { include: ["@stello/shared"] },
  server: { port: 5175 },
});
```

- [ ] **Step 4: Build**

Run: `pnpm --filter @stello/edge build` (run `pnpm --filter @stello/shared build` first if `applyTheme` can't resolve). Expected: `vite build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/edge/src/ThemeProvider.tsx apps/edge/src/App.tsx apps/edge/vite.config.ts
git commit -m "feat(edge): apply the cached brand theme via ThemeProvider"
```

---

### Task 3: Remap edge styles.css onto tokens + verify all themes

**Files:**
- Modify: `apps/edge/src/styles.css`

**Interfaces:**
- Consumes: the CSS variables written by the `ThemeProvider` (Task 2); `REQUIRED_TOKENS`.
- Produces: an edge terminal that renders coherently in every theme.

- [ ] **Step 1: Replace the `:root` palette with shared-token defaults + aliases**

At the top of `styles.css`, replace the current `:root { --ink … --sans }` block with (a) the shared-token counter defaults (identical to the Order/POS block) and (b) the edge palette redefined as aliases per the mapping table (keep `--sans`/`--mono`). Remove the old `--ink` definition (it collided with the shared text token); `body` background becomes `var(--bg)` and `body` color `var(--ink)`.

```css
:root {
  --bg:#f8fafc; --panel:#ffffff; --panel-2:#f1f5f9; --card-bg:#ffffff;
  --ink:#0f172a; --muted:#64748b; --faint:#94a3b8; --line:#e2e8f0;
  --accent:#6366f1; --accent-ink:#ffffff; --accent-soft:#e6e7fd;
  --veg:#16a34a; --nonveg:#dc2626; --good:#2f7d47; --warn:#c07a09; --crit:#b23a32;
  --radius:14px; --radius-sm:9px; --gap:12px; --shadow:0 10px 26px rgba(15,23,42,.06);

  --slate: var(--panel);
  --slate-2: var(--panel-2);
  --cream: var(--ink);
  --saffron: var(--accent);
  --saffron-deep: var(--accent);
  --mint: var(--good);
  --chili: var(--crit);
  --leaf: var(--veg);

  --sans: "Space Grotesk", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, monospace;
}
```

Note: do NOT re-alias `--line`/`--muted`/`--faint` — they are shared token names driven by `applyTheme` (the defaults above cover the pre-paint).

- [ ] **Step 2: Migrate `var(--ink)` background usages to `var(--bg)`**

`var(--ink)` is used as a background in `body`, `.edge-bill`, and the `.connect` gradient. Change those to `var(--bg)`. There must be zero background usages of `var(--ink)` afterward (edge text comes through `--cream` → `--ink`).

- [ ] **Step 3: Tokenize remaining hardcoded hex + rgba tints**

- `#241a08` (btn text on accent, ×2: `.btn-primary`, `.eh-btn`) → `var(--accent-ink)`.
- `.connect` gradient: `radial-gradient(120% 100% at 50% 0%, #211c17 0%, var(--ink) 60%)` → `radial-gradient(120% 100% at 50% 0%, var(--panel-2) 0%, var(--bg) 60%)`.
- `.edge-error` color `#f3b4a3` → `var(--crit)`; its `rgba(226,84,42,.14)` bg → `color-mix(in srgb, var(--crit) 14%, transparent)`.
- `.flash` `rgba(45,212,167,.14)` bg → `color-mix(in srgb, var(--good) 14%, transparent)`; color `var(--mint)` → `var(--good)` (via alias, already covered).
- `.net.online .net-dot` glow `0 0 8px var(--mint)` → `var(--good)`.
- `.sync-pill.synced` border `rgba(45,212,167,.4)` → `color-mix(in srgb, var(--good) 40%, transparent)`.
- `.sync-pill.pending` border `rgba(245,166,35,.4)` → `color-mix(in srgb, var(--accent) 40%, transparent)` (colour already `--saffron`→`--accent` via alias).
- Radii: tokenize card/button radii to `var(--radius)` (cards: `.eitem`, `.connect-card`) / `var(--radius-sm)` (buttons/chips: `.btn-primary`, `.eh-btn`, `.ecat`, `.eb-step button`). Keep `999px` pills, `50%` circles, and tiny functional radii (veg-dot `3px`) literal.

Run: `grep -nE "#[0-9a-fA-F]{3,6}" apps/edge/src/styles.css`
Expected: only the `:root` default block (+ any itemized non-themed values).

- [ ] **Step 4: Build**

Run: `pnpm --filter @stello/edge build`. Expected: succeeds.

- [ ] **Step 5: Verify all themes render (verify skill)**

Start the sidecar (`pnpm --filter @stello/edge sidecar`) with the API + Docker Postgres up, bootstrap the device (`cashier@demo.com` / `password123`), then run the renderer (`pnpm --filter @stello/edge dev`, port 5175). Confirm the terminal renders in the seeded `counter` theme. Then change the brand theme in Console (or via `PATCH /brands/:id/theme`) to a dark theme (`line`, `noir`) and a light one (`thali`), trigger a sync (or wait for the 10s loop), reload the renderer, and confirm the header, category rail, item grid, bill pane, veg/non-veg dots, online/offline pill, and sync pills re-theme coherently and stay legible on both light and dark grounds. Reset to `counter` when done.

- [ ] **Step 6: Commit**

```bash
git add apps/edge/src/styles.css
git commit -m "feat(edge): render the offline terminal from design tokens; fully themeable"
```

---

## Definition of Done

- `pnpm --filter @stello/edge build` succeeds.
- The sidecar caches `themeId` from the snapshot and returns it on `/status`; the renderer applies it (verified across ≥2 light and ≥2 dark themes) and keeps the theme while offline.
- `grep` shows no `var(--ink)` background usages and no hardcoded design colours in `styles.css` outside the `:root` default block (+ itemized non-themed values).
- Scope stayed within `apps/edge/**` (no API/registry/other-app changes).

## Remaining themeable work (after this)

With Edge done, all five frontends (POS, KDS, Console, Scan & Order, Edge) are token-driven. The only remaining themeable item from the design spec §8 is **polishing all 11 themes across every screen**.
