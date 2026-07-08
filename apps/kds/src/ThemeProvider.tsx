import { useEffect } from "react";
import { applyTheme, getTheme, DEFAULT_THEME_ID } from "@stello/shared";

export function ThemeProvider({ themeId, children }: { themeId?: string; children: React.ReactNode }) {
  useEffect(() => {
    applyTheme(getTheme(themeId ?? DEFAULT_THEME_ID), document.documentElement);
  }, [themeId]);
  return <>{children}</>;
}
