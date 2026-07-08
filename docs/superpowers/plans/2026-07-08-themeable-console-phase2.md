# Themeable Console (Dashboard) — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin Console (`apps/dashboard`, Next.js) follow the brand's selected theme, so the whole back-office — including the Settings → Appearance picker's own chrome — re-themes.

**Architecture:** The Console already uses a pervasive CSS-variable palette (`--slate`, `--cream`, `--saffron`, …) across its hand-written `globals.css`; it uses **no Tailwind utility classes**. So theming is a pure **variable remap**: a client-side `ThemeProvider` applies the shared token set (`--bg`, `--ink`, `--accent`, …) onto `<html>`, and the Console's palette variables are redefined as aliases of those tokens. No Tailwind is added (it would only bring Preflight risk and no benefit here). Because `apps/dashboard/app/page.tsx` is a `"use client"` SPA (the theme is only known after client-side outlet selection), a client `ThemeProvider` — not SSR injection — is the correct approach; there is no server-known theme to inject.

**Tech Stack:** Next.js (client-rendered), React, TypeScript, `@stello/shared`.

## Global Constraints

- **Base branch:** stacks on Phase 1 + KDS. Branch off `feat/themeable-kds` (or off `main` once the Phase-1/KDS PRs merge) — the shared theme registry only exists on those branches.
- Scope is `apps/dashboard/**` only. Do NOT modify `@stello/shared`, `apps/api`, the root `tailwind.preset.cjs`, or other apps.
- Token variable names are those in `REQUIRED_TOKENS` (`packages/shared/src/theme.ts`). The `:root` shared-token defaults equal the `counter` theme (identical block used by POS and KDS).
- **No Tailwind** for the dashboard (unlike the POS/KDS pilots) — it uses no utility classes; theming is variable-only. Note this deviation is deliberate.
- **`--ink` collision (critical):** the Console currently defines `--ink: #14110f` and uses it as the darkest **background**. The shared token `--ink` is **text**. `applyTheme` sets `--ink` (text) as an inline style on `<html>`, which overrides the `:root` value — so the Console's background usages of `var(--ink)` MUST be migrated to `var(--bg)` and the `--ink` palette definition removed, or backgrounds will render in the text colour.
- **Same-named tokens** `--line`, `--muted`, `--faint` already exist in the Console palette AND are shared tokens; once `applyTheme` runs they are driven by the theme automatically (inline style wins). Keep them only in the `:root` default block (counter values).
- `ThemeProvider` mirrors the POS/KDS provider but is a Next **client component** (`"use client"`).
- Fonts: the Console uses `--sans`/`--mono` (Space Grotesk / IBM Plex Mono). Keep those as the Console's typographic identity; do NOT remap them to the theme fonts unless a later task decides to (out of scope here — themes changing surface/accent, not the Console's brand type).
- Verify with `pnpm --filter @stello/dashboard build` (`next build`) + a hardcoded-hex grep gate + a Playwright multi-theme render check (the dashboard dev server already worked in Phase 1).

## Palette remap (the mapping this plan applies)

| Console var (current) | Current value (dark) | Maps to shared token | Notes |
| --- | --- | --- | --- |
| `--ink` | `#14110f` (background!) | **`--bg`** | Migrate all `var(--ink)` bg usages → `var(--bg)`; remove `--ink` def (collides with shared text token). |
| `--slate` | `#1d1a17` | `--panel` | Panel surface. |
| `--slate-2` | `#262220` | `--panel-2` | Secondary panel. |
| `--cream` | `#f4ede2` | `--ink` | Console text → shared ink. |
| `--line` | `#363029` | `--line` | Same name — driven by theme at runtime; keep only as counter default. |
| `--muted` | `#a1968a` | `--muted` | Same name. |
| `--faint` | `#6f665c` | `--faint` | Same name. |
| `--saffron` | `#f5a623` | `--accent` | Primary accent. |
| `--saffron-deep` | `#d98613` | `--accent` | Accent (hover/deep) — same token; if a distinct darker shade is needed later, use `color-mix`. |
| `--chili` | `#e2542a` | `--crit` | Danger/negative. |
| `--leaf` | `#57a55a` | `--good` | Positive/success. |
| `--mint` | `#2dd4a7` | `--good` | Secondary positive accent (verify usage; if it's a neutral accent, `--accent-soft`). |
| `--sans`, `--mono` | fonts | (unchanged) | Console keeps its own type identity. |

---

### Task 1: Console ThemeProvider + app wiring

**Files:**
- Create: `apps/dashboard/components/ThemeProvider.tsx`
- Modify: `apps/dashboard/app/page.tsx` (wrap all render branches)

**Interfaces:**
- Consumes: `applyTheme`, `getTheme`, `DEFAULT_THEME_ID` from `@stello/shared`; `OutletDto.themeId`.
- Produces: `<ThemeProvider themeId={...}>` applying tokens to `document.documentElement`.

- [ ] **Step 1: Create the client provider**

Create `apps/dashboard/components/ThemeProvider.tsx`:

```tsx
"use client";
import { useEffect } from "react";
import { applyTheme, getTheme, DEFAULT_THEME_ID } from "@stello/shared";

export function ThemeProvider({ themeId, children }: { themeId?: string; children: React.ReactNode }) {
  useEffect(() => {
    applyTheme(getTheme(themeId ?? DEFAULT_THEME_ID), document.documentElement);
  }, [themeId]);
  return <>{children}</>;
}
```

- [ ] **Step 2: Wrap every render branch in page.tsx**

`apps/dashboard/app/page.tsx` (already `"use client"`) has four returns: `loading`, `Login`, `pick-outlet`, and `Console`. Import the provider and wrap each. Use `themeId={outlet?.themeId}` on the branches where `outlet` may be set (loading, Login, Console); in the `if (!outlet)` pick-outlet branch, TypeScript narrows `outlet` to `null`, so use a **bare `<ThemeProvider>`** (defaults to `counter`) — the same convention the POS and KDS apps use for that one branch. Add:

```tsx
import { ThemeProvider } from "@/components/ThemeProvider";
```

and wrap each return, e.g. the Console one:

```tsx
return (
  <ThemeProvider themeId={outlet?.themeId}>
    <Console user={user} outlet={outlet} /* …existing props unchanged… */ />
  </ThemeProvider>
);
```

Do not change any other logic or markup.

- [ ] **Step 3: Build to verify**

Run: `pnpm --filter @stello/dashboard build`
Expected: `next build` succeeds. (The dashboard already has `transpilePackages: ["@stello/shared"]` in `next.config.mjs` from Phase 1, so the runtime import resolves.)

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/components/ThemeProvider.tsx apps/dashboard/app/page.tsx
git commit -m "feat(dashboard): apply the outlet's brand theme via ThemeProvider"
```

---

### Task 2: Remap the Console palette onto shared tokens

**Files:**
- Modify: `apps/dashboard/app/globals.css` (the `:root` block + `--ink`→`--bg` background migration)

**Interfaces:**
- Consumes: the CSS variables written by the `ThemeProvider` (Task 1); `REQUIRED_TOKENS`.
- Produces: a Console whose palette variables are driven by the active theme.

- [ ] **Step 1: Add the shared-token defaults and alias the palette**

Replace the current `:root { --ink … --sans }` block at the top of `apps/dashboard/app/globals.css` with: (a) the shared-token counter defaults (so the Console is styled before `applyTheme` runs), and (b) the Console palette variables redefined as aliases of the shared tokens, per the mapping table. Keep `--sans`/`--mono` as-is.

```css
:root {
  /* shared token defaults = counter theme; applyTheme overrides these on <html> at runtime */
  --bg:#f8fafc; --panel:#ffffff; --panel-2:#f1f5f9; --card-bg:#ffffff;
  --ink:#0f172a; --muted:#64748b; --faint:#94a3b8; --line:#e2e8f0;
  --accent:#6366f1; --accent-ink:#ffffff; --accent-soft:#e6e7fd;
  --veg:#16a34a; --nonveg:#dc2626; --good:#2f7d47; --warn:#c07a09; --crit:#b23a32;
  --radius:14px; --radius-sm:9px; --gap:12px; --shadow:0 10px 26px rgba(15,23,42,.06);
  --font-display:ui-sans-serif,system-ui,sans-serif; --font-body:ui-sans-serif,system-ui,sans-serif;
  --font-num:ui-sans-serif,system-ui,sans-serif; --label-tt:none; --label-ls:0;

  /* Console palette aliased to the theme tokens (was a fixed dark palette) */
  --slate: var(--panel);
  --slate-2: var(--panel-2);
  --cream: var(--ink);
  --saffron: var(--accent);
  --saffron-deep: var(--accent);
  --chili: var(--crit);
  --leaf: var(--good);
  --mint: var(--good);

  /* Console keeps its own type identity */
  --mono: "IBM Plex Mono", ui-monospace, monospace;
  --sans: "Space Grotesk", system-ui, sans-serif;
}
```

Note: do NOT redefine `--line`/`--muted`/`--faint` as aliases — they are shared token names already present in the defaults above and are driven by `applyTheme` at runtime.

- [ ] **Step 2: Migrate the `--ink` background usages to `--bg`**

The Console used `var(--ink)` (its darkest colour) in 9 places. Find each and decide per usage:

Run to locate: `grep -n "var(--ink)" apps/dashboard/app/globals.css`
For each occurrence, look at the property:
- If it's a **background/fill** (`background`, `background-color`, `fill`, box-shadow colour, a sunken well, the page background) → change to `var(--bg)`. These were the dark surface; they must follow the theme's background.
- If it's a **text/foreground** colour (`color`, or an icon stroke) — e.g. dark text on a light saffron chip — → **leave it as `var(--ink)`**. The shared `--ink` token (theme text colour, set by `applyTheme`) is exactly what it should be now.

After this pass there must be **zero background usages** of `var(--ink)` left; any remaining `var(--ink)` must be a genuine text/foreground colour (note which in your report). The Console's body text comes through `--cream` → `--ink`.

- [ ] **Step 3: Build and verify the remap themes the console**

Run: `pnpm --filter @stello/dashboard build`
Expected: `next build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/app/globals.css
git commit -m "feat(dashboard): drive the Console palette from theme tokens"
```

---

### Task 3: Tokenize remaining hardcoded colours + verify all themes

**Files:**
- Modify: `apps/dashboard/app/globals.css` (remaining raw hex)
- Modify: up to 2 component files under `apps/dashboard/components/**` that carry inline hex

**Interfaces:**
- Consumes: the tokens/aliases established in Task 2.
- Produces: a Console with no stray hardcoded design colours, verified across themes.

- [ ] **Step 1: Tokenize remaining raw hex in globals.css**

Beyond the `:root` defaults, `globals.css` contains ~139 raw hex colour usages (rule bodies, gradients, shadows, status pills). Replace hardcoded design colours with the appropriate token or Console alias, per the same mapping rules the POS/KDS pilots used:
- surfaces → `var(--bg)`/`var(--panel)`/`var(--panel-2)`/`var(--card-bg)` (or the aliases `--slate`/`--slate-2`)
- text → `var(--ink)`/`var(--muted)`/`var(--faint)` (or `--cream`)
- borders → `var(--line)`; accents → `var(--accent)`/`var(--accent-soft)` (or `--saffron`)
- success/warn/danger → `var(--good)`/`var(--warn)`/`var(--crit)` (or `--leaf`/`--chili`)
- radii → `var(--radius)`/`var(--radius-sm)` (keep `999px` pills and `50%` circles as shape constants)

Leave genuinely non-themed values (a pure-black scrim/overlay, e.g. `rgba(0,0,0,.x)`) as-is and itemize them in the report. Then verify:

Run: `grep -nE "#[0-9a-fA-F]{3,6}" apps/dashboard/app/globals.css`
Expected: only the `:root` shared-token default block (and any itemized non-themed values).

- [ ] **Step 2: Tokenize inline hex in components**

Run: `grep -rnE "#[0-9a-fA-F]{3,6}" apps/dashboard/components`
For each of the (≤2) component files with inline hex, replace design colours with the matching token/alias. Do NOT touch the Settings → Appearance theme-card previews (`AppearanceTab.tsx`) — those inline styles come from `theme.tokens` on purpose (each card shows its own theme's colours) and must stay.

- [ ] **Step 3: Build**

Run: `pnpm --filter @stello/dashboard build`
Expected: `next build` succeeds.

- [ ] **Step 4: Verify all themes render (verify skill)**

With Docker Postgres up and the API running, run `pnpm --filter @stello/dashboard dev` (on an alternate port if needed; do NOT touch port 3001). Sign in as `admin@demo.com`/`password123`, pick an outlet. Via Settings → Appearance, switch the brand theme to `counter`, `line`, `ember`, `thali`, and `noir` in turn (the picker persists it), reloading the console each time. Confirm the whole console — sidebar, tabs, tables, cards, forms, status pills, and the Appearance picker's own chrome — re-themes coherently and stays legible on both light and dark grounds. Use Playwright to load and screenshot if available. Reset to `counter` when done.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/app/globals.css apps/dashboard/components
git commit -m "feat(dashboard): tokenize remaining colours; console fully themeable"
```

---

## Definition of Done

- `pnpm --filter @stello/dashboard build` succeeds.
- The Console applies the selected outlet's brand theme, defaults to `counter` before selection, resets on logout; the whole back-office (incl. the Appearance picker chrome) re-themes.
- `grep` shows no `var(--ink)` background usages and no hardcoded design colours in `globals.css` outside the `:root` default block (and itemized non-themed values).
- The Appearance theme-card previews still show each theme's own colours (unchanged).
- Verified across at least two light and two dark themes.
- Scope stayed within `apps/dashboard/**`.

## Next Phase-2 apps (separate plans)

Scan & Order (`apps/order`, theme from the public scan token — needs an API change to include `themeId` on the public scan context) and Edge (`apps/edge`, theme from `/sync/snapshot`, offline).
