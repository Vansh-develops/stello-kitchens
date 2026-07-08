import { describe, it, expect } from "vitest";
import {
  THEMES, DEFAULT_THEME_ID, getTheme, isThemeId, REQUIRED_TOKENS, applyTheme, type Theme,
} from "./theme";

describe("theme registry", () => {
  it("has the 11 expected theme ids", () => {
    expect(THEMES.map((t) => t.id).sort()).toEqual(
      ["aurora","console","counter","ember","herb","line","mise","noir","slate","thali","tiffin"]
    );
  });

  it("every theme defines every required token", () => {
    for (const t of THEMES) {
      for (const key of REQUIRED_TOKENS) {
        expect(t.tokens[key], `${t.id} missing ${key}`).toBeTruthy();
      }
    }
  });

  it("default theme exists", () => {
    expect(isThemeId(DEFAULT_THEME_ID)).toBe(true);
    expect(getTheme(DEFAULT_THEME_ID).id).toBe(DEFAULT_THEME_ID);
  });

  it("getTheme falls back to default on unknown id", () => {
    expect(getTheme("nope").id).toBe(DEFAULT_THEME_ID);
    expect(isThemeId("nope")).toBe(false);
  });

  it("body text is legible on the background (WCAG AA >= 4.5)", () => {
    const hex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);
    const lum = (h: string) => {
      const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    // Body-text legibility: ink on the page background. (Accent-button label
    // contrast is large-text and tuned per app in Phase 2.) Skip non-hex
    // tokens such as Aurora's gradient background.
    for (const t of THEMES) {
      const ink = t.tokens["--ink"], bg = t.tokens["--bg"];
      if (hex(ink) && hex(bg)) {
        expect(ratio(ink, bg), `${t.id} body contrast`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("applyTheme writes every token and stamps data attributes", () => {
    const set: Record<string, string> = {};
    const attrs: Record<string, string> = {};
    const target = {
      style: {
        setProperty: (p: string, v: string) => { set[p] = v; },
        removeProperty: (_p: string) => {},
      },
      setAttribute: (n: string, v: string) => { attrs[n] = v; },
    };
    const theme = getTheme("line");
    applyTheme(theme as Theme, target);
    expect(set["--accent"]).toBe(theme.tokens["--accent"]);
    expect(attrs["data-theme"]).toBe("line");
    expect(attrs["data-mode"]).toBe("dark");
  });

  it("applyTheme removes optional tokens not present in the incoming theme", () => {
    const set: Record<string, string> = {};
    const removed: string[] = [];
    const target = {
      style: {
        setProperty: (p: string, v: string) => { set[p] = v; },
        removeProperty: (p: string) => { removed.push(p); delete set[p]; },
      },
      setAttribute: (_n: string, _v: string) => {},
    };
    applyTheme(getTheme("aurora") as Theme, target);
    expect(set["--card-blur"]).toBe(getTheme("aurora").tokens["--card-blur"]);

    applyTheme(getTheme("counter") as Theme, target);
    expect(removed).toContain("--card-blur");
    expect(set["--card-blur"]).toBeUndefined();
  });
});
