"use client";

import { useState } from "react";
import type { OutletDto } from "@stello/shared";
import { THEMES } from "@stello/shared";
import { api } from "../lib/api";

export function AppearanceTab({ outlet }: { outlet: OutletDto }) {
  const [selected, setSelected] = useState(outlet.themeId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const current = THEMES.find((t) => t.id === selected) ?? THEMES[0];

  const save = async () => {
    setSaving(true);
    try {
      await api.setBrandTheme(outlet.brandId, selected);
      setSaved(selected);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="appearance">
      <h2>Appearance</h2>
      <p className="muted">
        Choose the theme for <b>{outlet.brandName}</b>. Applies brand-wide across POS, KDS,
        Console, Scan &amp; Order, and Edge.
      </p>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`theme-card${t.id === selected ? " sel" : ""}`}
            onClick={() => setSelected(t.id)}
            aria-pressed={t.id === selected}
          >
            <span className="theme-prev" style={{ background: t.tokens["--bg"], color: t.tokens["--ink"] }}>
              <span className="tw" style={{ color: t.tokens["--accent"] }}>STELLO KITCHENS</span>
              <span className="tbtn" style={{ background: t.tokens["--accent"], color: t.tokens["--accent-ink"] }}>
                Send KOT
              </span>
            </span>
            <span className="theme-meta">
              <b>{t.name}</b>
              <span className={`mode ${t.mode}`}>{t.mode}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="appearance-actions">
        <span className="muted">Selected: <b>{current.name}</b></span>
        <button className="btn-primary" onClick={save} disabled={saving || saved === selected}>
          {saving ? "Saving…" : saved === selected ? "Saved" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
