# Themeable KDS — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Kitchen Display System (`apps/kds`) render from the shared design tokens so it follows the brand's selected theme — the second app to adopt the token system after the POS pilot.

**Architecture:** Reuse the Phase-1 foundations unchanged: the theme registry and `applyTheme` in `@stello/shared`, the brand theme already carried on `OutletDto.themeId`, and the repo-root `tailwind.preset.cjs`. Add a KDS `ThemeProvider` that applies the selected outlet's theme, and refactor `apps/kds/src/styles.css` to consume tokens (including mapping the ticket ageing tones to the semantic `--good`/`--warn`/`--crit` tokens).

**Tech Stack:** React + Vite (KDS), TypeScript, Tailwind CSS (shared preset), `@stello/shared`.

## Global Constraints

- **Base branch:** this plan builds on Phase 1. Branch off `feat/themeable-design-system` (or off `main` once Phase 1 PR #2 is merged) — the shared theme registry and `tailwind.preset.cjs` do not exist on `main` yet.
- Scope is `apps/kds/**` only. Do NOT modify `@stello/shared`, `apps/api`, the shared `tailwind.preset.cjs`, or other apps.
- Token variable names come from `REQUIRED_TOKENS` in `packages/shared/src/theme.ts` — use those exact names. The `:root` default block equals the `counter` theme (matches the POS pilot) so the screen is styled before `applyTheme` runs.
- KDS follows the **brand theme** like every other surface (per the approved spec). Some themes are dark (line, ember, noir), some light (counter, thali) — the KDS must render coherently in all of them. (If the owner later wants the KDS forced dark regardless of brand theme for wall legibility, that is a separate follow-up, not this plan.)
- Follow the pattern already proven on the POS: `ThemeProvider` (commits 582c2e7 + d745954) and token adoption via the shared preset (commit cfac81d). The KDS `ThemeProvider` is byte-identical to `apps/pos/src/ThemeProvider.tsx`.
- Fonts are system stacks only (already true in KDS). No new runtime deps beyond Tailwind's build tooling.
- KDS has no test runner; verification is `pnpm --filter @stello/kds build` + a hardcoded-hex grep gate + a multi-theme visual check.

---

### Task 1: KDS ThemeProvider + app wiring + Vite CJS-interop

**Files:**
- Create: `apps/kds/src/ThemeProvider.tsx`
- Modify: `apps/kds/src/App.tsx` (wrap all render branches)
- Modify: `apps/kds/vite.config.ts` (add `build.commonjsOptions.include` for the workspace package)

**Interfaces:**
- Consumes: `applyTheme`, `getTheme`, `DEFAULT_THEME_ID` from `@stello/shared` (Phase 1); `OutletDto.themeId` (Phase 1).
- Produces: `<ThemeProvider themeId={...}>` applying tokens to `document.documentElement`.

- [ ] **Step 1: Create the provider**

Create `apps/kds/src/ThemeProvider.tsx` (identical to the POS provider):

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

- [ ] **Step 2: Wire it into App, wrapping every return branch**

In `apps/kds/src/App.tsx`, import the provider and wrap **all four** render branches — `loading`, `LoginScreen`, `pick-outlet`, and `Board` — each in `<ThemeProvider themeId={outlet?.themeId}>`. On the login/loading/pick screens `outlet` is null → `themeId` undefined → the default `counter` theme applies; when a `Board` outlet is chosen its brand `themeId` applies; on exit (which sets `outlet` back to null) the default re-applies (Phase 1's `applyTheme` also clears optional tokens, so no stale theme lingers).

Add the import:

```tsx
import { ThemeProvider } from "./ThemeProvider";
```

Wrap each existing return, e.g.:

```tsx
if (loading) return <ThemeProvider themeId={outlet?.themeId}><div className="boot">Connecting to kitchen…</div></ThemeProvider>;
```

and likewise wrap the `LoginScreen` return, the `pick-outlet` return, and the final `Board` return. Do NOT change any other logic or markup — only add the import and the wrappers.

- [ ] **Step 3: Add the Vite CJS-interop for the workspace package**

`@stello/shared` compiles to CommonJS and is pnpm-symlinked outside `node_modules`, so Rollup's default `commonjsOptions` (node_modules only) fails to resolve the first *runtime* import (`applyTheme` etc.) from KDS. Mirror the POS fix. In `apps/kds/vite.config.ts`, add a `build.commonjsOptions.include` while preserving the existing `plugins: [react()]` and `server` block:

```ts
export default defineConfig({
  plugins: [react()],
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages\/shared/],
    },
  },
  server: {
    // ...keep the existing server/proxy config unchanged...
  },
});
```

(Read the current `apps/kds/vite.config.ts` first and add only the `build` block — do not drop the react plugin, port, or the existing `/api` and `/socket.io` proxies.)

- [ ] **Step 4: Build to verify**

Run: `pnpm --filter @stello/kds build`
Expected: `tsc` + `vite build` succeed with no errors. (If it fails to resolve `applyTheme`/`getTheme` from `@stello/shared`, ensure `packages/shared` is built: `pnpm --filter @stello/shared build`, then rebuild KDS.)

- [ ] **Step 5: Commit**

```bash
git add apps/kds/src/ThemeProvider.tsx apps/kds/src/App.tsx apps/kds/vite.config.ts
git commit -m "feat(kds): apply the outlet's brand theme via ThemeProvider"
```

---

### Task 2: KDS renders from design tokens (Tailwind preset + styles.css)

**Files:**
- Create: `apps/kds/tailwind.config.cjs`
- Create: `apps/kds/postcss.config.cjs`
- Modify: `apps/kds/src/styles.css` (add `@tailwind` layers + `:root` defaults; replace hardcoded colours with `var(--token)`; map ageing tones to semantic tokens)
- Modify: `apps/kds/package.json` (add tailwindcss, postcss, autoprefixer devDeps)

**Interfaces:**
- Consumes: the CSS variables written by the KDS `ThemeProvider` (Task 1); the token names from `REQUIRED_TOKENS`; the repo-root `tailwind.preset.cjs`.
- Produces: a KDS that renders entirely from tokens (all 11 themes work).

- [ ] **Step 1: Install styling dependencies**

Run: `pnpm --filter @stello/kds add -D tailwindcss@^3.4.0 postcss autoprefixer`
Expected: added without peer-dep errors.

- [ ] **Step 2: Create the Tailwind + PostCSS config (reusing the shared preset)**

Create `apps/kds/tailwind.config.cjs`:

```js
module.exports = {
  presets: [require("../../tailwind.preset.cjs")],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
};
```

Create `apps/kds/postcss.config.cjs`:

```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 3: Add Tailwind layers + token defaults at the top of the stylesheet**

At the very top of `apps/kds/src/styles.css`, add the Tailwind layers and a `:root` fallback token set equal to the `counter` theme (identical to the POS pilot), so the screen is styled before `applyTheme` runs:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg:#f8fafc; --panel:#ffffff; --panel-2:#f1f5f9; --card-bg:#ffffff;
  --ink:#0f172a; --muted:#64748b; --faint:#94a3b8; --line:#e2e8f0;
  --accent:#6366f1; --accent-ink:#ffffff; --accent-soft:#e6e7fd;
  --veg:#16a34a; --nonveg:#dc2626; --good:#2f7d47; --warn:#c07a09; --crit:#b23a32;
  --radius:14px; --radius-sm:9px; --gap:12px; --shadow:0 10px 26px rgba(15,23,42,.06);
  --font-display:ui-sans-serif,system-ui,sans-serif; --font-body:ui-sans-serif,system-ui,sans-serif;
  --font-num:ui-sans-serif,system-ui,sans-serif; --label-tt:none; --label-ls:0;
}
```

- [ ] **Step 4: Replace hardcoded colours with tokens (incl. ageing tones)**

Go through `apps/kds/src/styles.css` (~589 lines, ~16 hardcoded colours) and replace hardcoded design values with tokens. Apply the same mapping rules the POS pilot used:
- Wall/page background → `var(--bg)`; lanes/panels → `var(--panel)` / `var(--panel-2)`; ticket cards → `var(--card-bg)`.
- Primary text → `var(--ink)`; secondary → `var(--muted)`; tertiary/empty → `var(--faint)`.
- Borders/lane dividers → `var(--line)`.
- Wordmark / accent / active station tab → `var(--accent)` (text `var(--accent-ink)`, tints `var(--accent-soft)`).
- Corner radii → `var(--radius)` / `var(--radius-sm)`; card shadow → `var(--shadow)`.
- Wordmark/headers → `var(--font-display)`; any numeric counts/timers → `var(--font-num)` + `font-variant-numeric: tabular-nums`; uppercase labels → `text-transform: var(--label-tt); letter-spacing: var(--label-ls);`.

**Ageing tones (the KDS-specific mapping):** `Board.tsx` sets a tone class on each ticket — `fresh` / `warm` / `late` (from `ageColor`) and `done` (for READY). Map their colour to the semantic tokens so ageing reads correctly in every theme:
- `.fresh` (and the New lane accent) → `var(--good)`
- `.warm` → `var(--warn)`
- `.late` → `var(--crit)`
- `.done` / READY → `var(--faint)` (or `var(--muted)`)

Do not change layout, class names, or markup — only values. Then verify no stray hardcoded design colours remain:

Run: `grep -nE "#[0-9a-fA-F]{3,6}" apps/kds/src/styles.css`
Expected: only the `:root` default block from Step 3 (list any intentionally non-themed values, e.g. a pure-black scrim, in your report).

- [ ] **Step 5: Build**

Run: `pnpm --filter @stello/kds build`
Expected: `tsc -b && vite build` succeeds; Tailwind compiles.

- [ ] **Step 6: Verify all themes render (verify skill)**

Run `pnpm dev:kds` with the API up (`pnpm dev:api`, Docker Postgres running), sign in as `kitchen@demo.com`/`password123` (or `admin@demo.com`), and open the board. Using the Console → Settings → Appearance (or the API `PATCH /brands/:id/theme`), switch the brand theme to `ember`, `line`, `counter`, and `noir` in turn, reloading the KDS each time. Confirm each renders coherently — surfaces, accent, lane headers, and especially the ageing tones (New = good/green, ageing = warn/amber, late = crit/red) stay glanceable and legible on both dark and light grounds. Reset the brand theme to `counter` when done.

- [ ] **Step 7: Commit**

```bash
git add apps/kds/tailwind.config.cjs apps/kds/postcss.config.cjs apps/kds/src/styles.css apps/kds/package.json pnpm-lock.yaml
git commit -m "feat(kds): render from design tokens via shared Tailwind preset"
```

---

## Definition of Done

- `pnpm --filter @stello/kds build` succeeds.
- The KDS applies the selected outlet's brand theme (verified across at least one dark and one light theme), defaults to `counter` before outlet selection, and resets to default on exit.
- The grep gate shows no hardcoded design colours in `styles.css` outside the `:root` default block.
- Ageing tones (fresh/warm/late/done) read correctly via `--good`/`--warn`/`--crit`/`--faint` in every theme.
- Scope stayed within `apps/kds/**`; no changes to shared, API, the preset, or other apps.

## Next Phase-2 apps (separate plans)

Console self-theming (with SSR no-FOUC in `app/layout.tsx`), Scan & Order (`apps/order`, theme from the public scan token), and Edge (`apps/edge`, theme from `/sync/snapshot`).
