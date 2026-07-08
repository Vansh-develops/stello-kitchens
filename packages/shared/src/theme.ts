export type ThemeMode = "light" | "dark";

export interface Theme {
  id: string;
  letter: string;
  name: string;
  description: string;
  mode: ThemeMode;
  tokens: Record<string, string>;
}

/** Structural target so this file stays DOM-free (shared tsconfig has no DOM lib). */
export type StyleTarget = {
  style: { setProperty(prop: string, value: string): void; removeProperty(prop: string): void };
  setAttribute(name: string, value: string): void;
};

const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const MONO = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

export const REQUIRED_TOKENS = [
  "--bg","--panel","--panel-2","--card-bg","--ink","--muted","--faint","--line",
  "--accent","--accent-ink","--accent-soft","--veg","--nonveg","--good","--warn","--crit",
  "--radius","--radius-sm","--gap","--shadow","--font-display","--font-body","--font-num",
  "--label-tt","--label-ls",
];

type Tok = Record<string, string>;
const lightBase: Tok = { "--good": "#2f7d47", "--warn": "#c07a09", "--crit": "#b23a32",
  "--font-body": SANS, "--gap": "12px", "--label-tt": "none", "--label-ls": "0" };
const darkBase: Tok = { "--good": "#5fbb76", "--warn": "#e0a83c", "--crit": "#e07069",
  "--font-body": SANS, "--gap": "10px", "--label-tt": "none", "--label-ls": "0" };

function make(id: string, letter: string, name: string, description: string,
  mode: ThemeMode, overrides: Tok): Theme {
  return { id, letter, name, description, mode,
    tokens: { ...(mode === "dark" ? darkBase : lightBase), ...overrides } };
}

export const THEMES: Theme[] = [
  make("mise","A","Mise en Place","Warm premium hospitality","light",{
    "--bg":"#fbf7ef","--panel":"#fdfbf5","--panel-2":"#f2ebdd","--card-bg":"#fffdf7","--ink":"#2a2018",
    "--muted":"#7c6f5c","--faint":"#a99e88","--line":"#e6dcc8","--accent":"#af5e17","--accent-ink":"#fdfbf5",
    "--accent-soft":"#f3e2cd","--veg":"#3f7d4f","--nonveg":"#ba4a1e","--radius":"16px","--radius-sm":"11px",
    "--shadow":"0 10px 30px rgba(120,90,40,.10)","--font-display":SERIF,"--font-num":SERIF }),
  make("line","B","Line","Sleek dark operator console","dark",{
    "--bg":"#0d1117","--panel":"#11161d","--panel-2":"#161c24","--card-bg":"#131922","--ink":"#e6edf3",
    "--muted":"#8b98a8","--faint":"#5b6675","--line":"#222b36","--accent":"#2dd4bf","--accent-ink":"#04120f",
    "--accent-soft":"#0f2a26","--veg":"#3fb950","--nonveg":"#f0883e","--radius":"10px","--radius-sm":"7px",
    "--shadow":"0 12px 34px rgba(0,0,0,.5)","--font-display":SANS,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".08em" }),
  make("counter","C","Counter","Bright modern SaaS","light",{
    "--bg":"#f8fafc","--panel":"#ffffff","--panel-2":"#f1f5f9","--card-bg":"#ffffff","--ink":"#0f172a",
    "--muted":"#64748b","--faint":"#94a3b8","--line":"#e2e8f0","--accent":"#5b5ef0","--accent-ink":"#ffffff",
    "--accent-soft":"#e6e7fd","--veg":"#16a34a","--nonveg":"#dc2626","--radius":"14px","--radius-sm":"9px",
    "--shadow":"0 10px 26px rgba(15,23,42,.06)","--font-display":SANS,"--font-num":SANS }),
  make("thali","D","Thali","Vibrant Indian editorial","light",{
    "--bg":"#fff8ec","--panel":"#fffdf8","--panel-2":"#ffeccd","--card-bg":"#fffdf8","--ink":"#241a3a",
    "--muted":"#7a6a86","--faint":"#b3a4bd","--line":"#f0dcc0","--accent":"#e77817","--accent-ink":"#2a1a05",
    "--accent-soft":"#ffe1bd","--veg":"#2f9e44","--nonveg":"#d1391f","--radius":"15px","--radius-sm":"10px",
    "--shadow":"0 12px 30px rgba(120,60,10,.13)","--font-display":SERIF,"--font-num":SANS }),
  make("slate","E","Slate","Swiss minimalist monochrome","light",{
    "--bg":"#f4f4f1","--panel":"#fbfbf9","--panel-2":"#ebebe7","--card-bg":"#fbfbf9","--ink":"#161615",
    "--muted":"#6a6a66","--faint":"#a6a6a0","--line":"#dbdbd5","--accent":"#18181a","--accent-ink":"#f4f4f1",
    "--accent-soft":"#e6e6e2","--veg":"#2f7d4f","--nonveg":"#c8442f","--radius":"5px","--radius-sm":"4px",
    "--shadow":"0 8px 22px rgba(0,0,0,.05)","--font-display":SANS,"--font-num":SANS,
    "--label-tt":"uppercase","--label-ls":".07em" }),
  make("aurora","F","Aurora","Glassmorphism soft-depth","light",{
    "--bg":"linear-gradient(135deg,#e5ecff 0%,#f4e6ff 45%,#ffe6f2 75%,#e2f6ff 100%)",
    "--panel":"rgba(255,255,255,.55)","--panel-2":"rgba(255,255,255,.42)","--card-bg":"rgba(255,255,255,.5)",
    "--ink":"#1e2140","--muted":"#5a5e86","--faint":"#9498c0","--line":"rgba(255,255,255,.7)",
    "--accent":"#7c3aed","--accent-ink":"#ffffff","--accent-soft":"rgba(124,58,237,.16)","--veg":"#0e9f6e",
    "--nonveg":"#e0417a","--radius":"18px","--radius-sm":"12px","--shadow":"0 20px 50px rgba(80,60,160,.18)",
    "--font-display":SANS,"--font-num":SANS,"--card-blur":"blur(14px) saturate(1.3)" }),
  make("ember","G","Ember","Warm dark terminal","dark",{
    "--bg":"#17120d","--panel":"#1e1811","--panel-2":"#241d14","--card-bg":"#211a12","--ink":"#f2e7d6",
    "--muted":"#a89479","--faint":"#6e6151","--line":"#342a1d","--accent":"#f0a13a","--accent-ink":"#1a1206",
    "--accent-soft":"#3a2a12","--veg":"#88b04b","--nonveg":"#e0783c","--radius":"11px","--radius-sm":"8px",
    "--shadow":"0 14px 36px rgba(0,0,0,.55)","--font-display":SANS,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".07em" }),
  make("console","H","Countertop Console","Neo-brutalist industrial","light",{
    "--bg":"#d8d3c4","--panel":"#e6e2d6","--panel-2":"#cfcabb","--card-bg":"#efece1","--ink":"#1b1c18",
    "--muted":"#54564b","--faint":"#8a8c7e","--line":"#1b1c18","--accent":"#ff5a1f","--accent-ink":"#1b1c18","--warn":"#a56908",
    "--accent-soft":"#ffd9c7","--veg":"#2f7d32","--nonveg":"#b3261e","--radius":"2px","--radius-sm":"1px",
    "--shadow":"4px 4px 0 0 #1b1c18","--font-display":SANS,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".08em","--btn-shadow":"3px 3px 0 0 #1b1c18" }),
  make("noir","I","Maison Noir","Fine-dining noir","dark",{
    "--bg":"#0b0a08","--panel":"#131109","--panel-2":"#1a1710","--card-bg":"#141108","--ink":"#efe7d6",
    "--muted":"#a89a7e","--faint":"#6e6552","--line":"#2a2517","--accent":"#c9a34e","--accent-ink":"#120d02",
    "--accent-soft":"#211a0d","--veg":"#8ba05a","--nonveg":"#c06a58","--radius":"10px","--radius-sm":"6px",
    "--shadow":"0 22px 50px -18px rgba(0,0,0,.72)","--font-display":SERIF,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".16em" }),
  make("herb","J","Herb & Honey","Fresh-market botanical","light",{
    "--bg":"#f4f6ee","--panel":"#fbfcf7","--panel-2":"#eef2e4","--card-bg":"#ffffff","--ink":"#22301f",
    "--muted":"#5e6d55","--faint":"#94a189","--line":"#dde3cf","--accent":"#2f7d3f","--accent-ink":"#f4f9ef",
    "--accent-soft":"#e2efd6","--veg":"#4f9f4f","--nonveg":"#c0492f","--radius":"18px","--radius-sm":"11px",
    "--shadow":"0 6px 20px -8px rgba(47,80,40,.28)","--font-display":SERIF,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".08em" }),
  make("tiffin","K","Tiffin Pop","Neo-bento QSR","light",{
    "--bg":"#fbf3ee","--panel":"#ffffff","--panel-2":"#fdece4","--card-bg":"#ffffff","--ink":"#2c2320",
    "--muted":"#736560","--faint":"#b8a89f","--line":"#f0ddd2","--accent":"#ff5a5f","--accent-ink":"#3a1012",
    "--accent-soft":"#ffe4e1","--veg":"#2a9f6d","--nonveg":"#e8543a","--radius":"20px","--radius-sm":"12px",
    "--shadow":"0 6px 0 #f2d9cd,0 12px 24px -12px rgba(255,90,95,.35)","--font-display":SANS,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".06em","--btn-shadow":"0 4px 0 #e8443f" }),
];

export const DEFAULT_THEME_ID = "counter";
const BY_ID = new Map(THEMES.map((t) => [t.id, t]));
export function isThemeId(id: string): boolean { return BY_ID.has(id); }
export function getTheme(id: string): Theme { return BY_ID.get(id) ?? BY_ID.get(DEFAULT_THEME_ID)!; }

const REQUIRED_TOKEN_SET = new Set(REQUIRED_TOKENS);
/** Every token key that appears in some theme but isn't required by all themes. */
const OPTIONAL_TOKENS: string[] = Array.from(
  new Set(THEMES.flatMap((t) => Object.keys(t.tokens)).filter((k) => !REQUIRED_TOKEN_SET.has(k)))
);

export function applyTheme(theme: Theme, root: StyleTarget): void {
  for (const [k, v] of Object.entries(theme.tokens)) root.style.setProperty(k, v);
  for (const key of OPTIONAL_TOKENS) {
    if (!(key in theme.tokens)) root.style.removeProperty(key);
  }
  root.setAttribute("data-theme", theme.id);
  root.setAttribute("data-mode", theme.mode);
}
