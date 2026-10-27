"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  formatINR,
  isLocale,
  normalizeLocale,
  translate,
  type Locale,
  type MessageDict,
  type TranslateParams,
} from "@stello/shared";
import { useSession } from "@/components/SessionProvider";
import { growthApi } from "@/lib/growth-api";
import { en, type MessageKey } from "./en";
import { hi } from "./hi";
import { mr, ta, te, bn, gu, kn } from "./scaffold";

const CATALOGUES: Partial<Record<Locale, MessageDict>> = { en, hi, mr, ta, te, bn, gu, kn };
const STORAGE_KEY = "stello.locale";

export type TFn = (key: MessageKey, params?: TranslateParams) => string;

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFn;
  /** Rupees with lakh/crore grouping; 2 decimals for bill amounts. */
  money: (n: number, decimals?: number) => string;
}

const englishT: TFn = (key, params) => translate(CATALOGUES, DEFAULT_LOCALE, key, params);
const fallback: I18n = {
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: englishT,
  money: (n, decimals = 2) => formatINR(n, { decimals }),
};

const Ctx = createContext<I18n>(fallback);

/** Current locale + translator. Works outside the provider too (English). */
export function useT(): I18n {
  return useContext(Ctx);
}

function readStored(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Staff UI language. Starts from this device's last choice (localStorage), then
 * adopts the signed-in user's saved preference from the server, so a cashier
 * gets their language on any terminal. Changing it writes both.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  const apply = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* storage unavailable — keep it for this session */
    }
    if (typeof document !== "undefined") document.documentElement.lang = l;
  }, []);

  useEffect(() => {
    const stored = readStored();
    if (stored) apply(stored);
  }, [apply]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    growthApi
      .preferences()
      .then((p) => {
        if (alive && p.locale) apply(normalizeLocale(p.locale));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user, apply]);

  const setLocale = useCallback(
    (l: Locale) => {
      apply(l);
      if (user) growthApi.setPreferences(l).catch(() => {});
    },
    [apply, user],
  );

  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(CATALOGUES, locale, key, params),
      money: (n, decimals = 2) => formatINR(n, { decimals }),
    }),
    [locale, setLocale],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Compact language picker (native names) for the POS, KDS and console headers. */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useT();
  return (
    <select
      className={`lang-switch ${className}`}
      aria-label={t("common.language")}
      title={t("common.language")}
      value={locale}
      onChange={(e) => setLocale(normalizeLocale(e.target.value))}
    >
      {SUPPORTED_LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.nativeName}
        </option>
      ))}
    </select>
  );
}
