/** Maps design tokens (CSS variables) to Tailwind utilities. Imported by every app config. */
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)", panel: "var(--panel)", "panel-2": "var(--panel-2)", card: "var(--card-bg)",
        ink: "var(--ink)", muted: "var(--muted)", faint: "var(--faint)", line: "var(--line)",
        accent: "var(--accent)", "accent-ink": "var(--accent-ink)", "accent-soft": "var(--accent-soft)",
        veg: "var(--veg)", nonveg: "var(--nonveg)", good: "var(--good)", warn: "var(--warn)", crit: "var(--crit)",
      },
      borderRadius: { DEFAULT: "var(--radius)", sm: "var(--radius-sm)" },
      fontFamily: { display: "var(--font-display)", body: "var(--font-body)", num: "var(--font-num)" },
      boxShadow: { card: "var(--shadow)" },
    },
  },
};
