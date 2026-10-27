import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  SUPPORTED_LOCALES,
  formatINR,
  isLocale,
  normalizeLocale,
  translate,
  type Locale,
  type MessageDict,
  type MenuItemDto,
  type TranslateParams,
} from "@stello/shared";
import { en, type MessageKey } from "./en";
import { hi } from "./hi";
import { mr, ta, te, bn, gu, kn } from "./scaffold";

const CATALOGUES: Partial<Record<Locale, MessageDict>> = { en, hi, mr, ta, te, bn, gu, kn };
const STORAGE_KEY = "stello.order.locale";

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, params?: TranslateParams) => string;
  /** Whole rupees with lakh grouping (menu prices are whole rupees). */
  money: (n: number) => string;
  /** The diner-facing item name in the current language, if the outlet translated it. */
  itemName: (item: Pick<MenuItemDto, "name" | "nameTranslations">) => string;
}

const Ctx = createContext<I18n | null>(null);

export function useT(): I18n {
  const c = useContext(Ctx);
  if (!c) throw new Error("useT must be used within <I18nProvider>");
  return c;
}

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isLocale(stored)) return stored;
  } catch {
    /* storage blocked */
  }
  // First visit: follow the phone's language (hi-IN → hi), English otherwise.
  return normalizeLocale(typeof navigator !== "undefined" ? navigator.language : null);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const l = initialLocale();
    document.documentElement.lang = l;
    return l;
  });

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.documentElement.lang = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* keep for this visit only */
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(CATALOGUES, locale, key, params),
      money: (n) => formatINR(n, { decimals: Number.isInteger(n) ? 0 : 2 }),
      itemName: (item) => item.nameTranslations?.[locale]?.trim() || item.name,
    }),
    [locale, setLocale],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Language picker shown in the menu header and on the token board. */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useT();
  return (
    <select
      className="lang-switch"
      aria-label={t("common.language")}
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
