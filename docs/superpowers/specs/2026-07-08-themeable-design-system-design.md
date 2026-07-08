# Themeable Design System — Design Spec

**Date:** 2026-07-08
**Status:** Approved (brainstorming), pending spec review
**Owner:** vansh@choruswave.com

## 1. Goal

Replace the ad-hoc, hand-written CSS across all five Stello Kitchens frontends with **one
token-driven design system**, and expose **theme selection in admin settings**. An owner
picks one of **11 themes** for their **brand**; every surface — POS, KDS, Console, Scan &
Order, Edge — renders in that theme, consistently, including offline.

The redesign and the theme feature are the same project: rebuilding each app's UI on shared
design tokens is what makes theming work.

## 2. Decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Theme scope | **Per brand** (`Brand.themeId`) | One identity per brand, shared by all its outlets. |
| Themes at launch | **All 11** (A–K) | They are just token sets; trivial to include. Owner gets full choice. |
| Build approach | **Bespoke on Tailwind** | Custom tokens + our own components (not shadcn defaults), so it never reads as templated. |
| Default theme | **`counter`** (C · bright SaaS) | Safe, neutral, high-legibility default; owners change it in settings. |
| Permission | **`settings.manage`** (owner-only) | Owner role holds `*`; cashier/kitchen are blocked (403). |
| Icons / motion | `lucide-react` + `framer-motion` | Behind thin wrappers so apps don't couple to them. |

**Non-goals (YAGNI):** per-user or per-device theme override; per-outlet override; a custom
accent-colour editor; user-uploaded themes; automatic OS light/dark (theme is explicit).
All are future work the schema can grow into without a rewrite.

## 3. Architecture overview

```
@stello/shared ── theme registry (11 themes × ~22 tokens) ── single source of truth
      │                         │
      │                         ├── ThemeProvider (per app) → sets CSS vars on :root
      │                         └── Admin picker (Console) → reads registry for previews
      │
apps/* consume tokens via Tailwind theme (colors/radius/fonts → var(--token))
      │
API exposes Brand.themeId → /auth/me · scan token · /sync/snapshot
Console → PATCH /brands/:id/theme { themeId } (owner-only) → persists
```

### 3.1 Token contract

Every theme defines the same set of semantic tokens (CSS custom properties). Apps reference
only these — never raw hex. The token set:

- **Surfaces:** `--bg`, `--panel`, `--panel-2`, `--card-bg`
- **Text:** `--ink`, `--muted`, `--faint`
- **Structure:** `--line`
- **Accent:** `--accent`, `--accent-ink`, `--accent-soft`
- **Food semantic:** `--veg`, `--nonveg`
- **State semantic (KDS/status):** `--good`, `--warn`, `--crit`
- **Shape:** `--radius`, `--radius-sm`, `--gap`
- **Elevation:** `--shadow`
- **Type:** `--font-display`, `--font-body`, `--font-num`
- **Label treatment:** `--label-tt` (`none`|`uppercase`), `--label-ls` (letter-spacing em)
- **Optional:** `--card-blur` (glass themes), `--btn-shadow`

A completeness invariant (enforced by test, §7): **every theme must define every required
token** so no app ever falls back to an unstyled value.

### 3.2 Theme registry (`@stello/shared`)

```ts
export type ThemeMode = 'light' | 'dark';
export interface Theme {
  id: string;              // stable slug, e.g. 'counter'
  letter: string;          // 'C' — gallery ordering/label
  name: string;            // 'Counter'
  description: string;     // 'Bright modern SaaS'
  mode: ThemeMode;         // drives base form controls / scrollbars
  tokens: Record<string, string>;   // '--bg' -> '#f8fafc', ...
}
export const THEMES: Theme[];                 // all 11
export const DEFAULT_THEME_ID = 'counter';
export function getTheme(id: string): Theme;  // falls back to default on unknown id
export function isThemeId(id: string): boolean;
```

The 11 themes (id · name · mode): `mise`·Mise en Place·light, `line`·Line·dark,
`counter`·Counter·light, `thali`·Thali·light, `slate`·Slate·light, `aurora`·Aurora·light,
`ember`·Ember·dark, `console`·Countertop Console·light, `noir`·Maison Noir·dark,
`herb`·Herb & Honey·light, `tiffin`·Tiffin Pop·light. (Token values are those validated in
the design demo.)

### 3.3 ThemeProvider (per app)

A small shared helper `applyTheme(theme)` sets each token on `document.documentElement`
via `style.setProperty`, and stamps `data-theme={id}` and `data-mode={mode}` on `<html>`.

- **Vite apps (pos, kds, order, edge):** a React `<ThemeProvider>` calls `applyTheme` on
  mount and whenever the resolved theme changes; the edge renderer reads the theme from the
  sidecar snapshot so it works offline.
- **Next.js (dashboard):** apply on the server by injecting the token style + `data-theme`
  on `<html>` in the root layout (avoids FOUC), then hydrate the same value client-side.

### 3.4 Tailwind integration

`tailwind.config` maps semantic names to the tokens so utility classes re-theme for free:

```js
theme: { extend: {
  colors: { bg:'var(--bg)', panel:'var(--panel)', ink:'var(--ink)', muted:'var(--muted)',
            line:'var(--line)', accent:'var(--accent)', 'accent-ink':'var(--accent-ink)',
            veg:'var(--veg)', nonveg:'var(--nonveg)', good:'var(--good)', warn:'var(--warn)',
            crit:'var(--crit)' },
  borderRadius: { DEFAULT:'var(--radius)', sm:'var(--radius-sm)' },
  fontFamily: { display:'var(--font-display)', body:'var(--font-body)', num:'var(--font-num)' },
  boxShadow: { card:'var(--shadow)' },
}}
```

Config lives in a shared preset imported by each app so all apps stay in lockstep.

## 4. Data model & migration

- Add to `Brand` (Prisma): `themeId String @default("counter")`.
- Migration: `add_brand_theme` (additive, safe — existing brands default to `counter`).
- Seed: set the demo brand's `themeId` to `counter` explicitly.

## 5. API

- **Expose the brand theme** (read):
  - `/auth/me` and the outlet DTO include `brandThemeId` for staff apps.
  - Diner scan endpoints (`/public/scan/...`) include `themeId` in the returned outlet
    context (keyed by the opaque token, no auth).
  - `/sync/snapshot` includes `themeId` so offline edge terminals theme correctly.
- **Persist** (write): `PATCH /brands/:id/theme` body `{ themeId }`.
  - Validated against the registry (`isThemeId`) → 400 on unknown id.
  - Gated by `settings.manage` (owner-only) → 403 otherwise.
  - Tenant-scoped: brand must belong to the caller's tenant → 404 otherwise.
  - Implemented in a minimal `BrandsModule` (controller + service).

## 6. Admin UI — Settings → Appearance

A new **Settings** area in the Console with an **Appearance** section (as mocked and
approved):

- A scope banner: *brand-wide, applies to all outlets and all apps*.
- A gallery of all 11 themes (mini preview, palette, light/dark badge, selected ring).
- A **live preview** panel (a representative mini-POS) that re-themes on selection.
- **Save** → `PATCH /brands/:id/theme`; Reset restores the persisted value.
- Reads `THEMES` and current `brandThemeId` from the API; owner-only route.

## 7. Testing strategy

- **Registry invariant:** a unit test asserts every theme in `THEMES` defines every required
  token key (from §3.1) and a valid `mode`. Guards against half-defined themes.
- **`getTheme` fallback:** unknown id → `DEFAULT_THEME_ID`.
- **API:** `PATCH /brands/:id/theme` — happy path persists; unknown id → 400; non-owner →
  403; cross-tenant brand → 404. `brandThemeId` present in `/auth/me` and `/sync/snapshot`.
- **ThemeProvider:** applying a theme sets the expected CSS vars and `data-theme`/`data-mode`.
- **Picker:** selecting a card updates the preview; Save issues the PATCH.
- **Accessibility:** accent-on-`accent-ink` and `ink`-on-`bg` meet WCAG AA per theme (a
  contrast assertion over the registry); `prefers-reduced-motion` honored by motion wrappers.
- **End-to-end (verify skill):** drive the POS in a couple of representative themes.

## 8. Rollout (phased)

**Phase 1 — infrastructure + POS pilot (first implementation plan):**
1. `@stello/shared`: theme registry, token contract, types, `getTheme`, registry test.
2. Shared Tailwind preset + install Tailwind, `lucide-react`, `framer-motion` where needed.
3. `ThemeProvider` (shared helper + POS wiring).
4. Prisma `Brand.themeId` + migration + seed.
5. API: expose `brandThemeId` (me + snapshot) and `PATCH /brands/:id/theme` + `settings.manage`.
6. Console: **Settings → Appearance** picker (reads registry, saves theme).
7. **Rebuild the POS UI on tokens** — the visible pilot that proves the system end-to-end
   in every theme.

**Phase 2 — roll out the token refactor** to KDS → Console (self-theming) → Scan & Order →
Edge, and polish all 11 themes across every screen. Each app is its own plan.

## 9. Risks & mitigations

- **CSS refactor is large (~5,355 lines).** Mitigate by doing POS first behind the token
  contract; other apps follow the proven pattern one at a time (Phase 2).
- **FOUC on the SSR dashboard.** Mitigate by applying the theme on `<html>` server-side.
- **Offline drift on edge.** Theme travels in `/sync/snapshot`; a terminal that has never
  synced uses `DEFAULT_THEME_ID`.
- **Webfonts blocked / heavy.** Themes preview with system stacks; embedding exact
  typefaces (self-hosted, subset) is a bounded follow-up, not a blocker.
- **Contrast regressions across 11 themes.** The AA contrast test over the registry catches
  a bad accent/ink pairing before it ships.

## 10. Definition of done (Phase 1)

Owner opens Settings → Appearance, picks any of the 11 themes, saves; the POS (and the
picker's own preview) render in that theme; a cashier is blocked from changing it; the
choice survives reload and reaches an edge terminal via snapshot; registry, API, and
provider tests pass.
