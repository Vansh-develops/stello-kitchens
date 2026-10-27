import { Menu } from "./Menu";
import { Board } from "./Board";
import { ThemeProvider } from "./ThemeProvider";
import { LanguageSwitcher, useT } from "./i18n";

// Tiny path router — the diner app is only ever opened via a QR deep link, so
// a full router dependency would be overkill.
export function App() {
  const { t } = useT();
  const parts = window.location.pathname.split("/").filter(Boolean);
  const [route, token] = parts;

  if (route === "t" && token) return <Menu mode="table" token={token} />;
  if (route === "kiosk" && token) return <Menu mode="kiosk" token={token} />;
  if (route === "board" && token) return <Board token={token} />;

  return (
    <ThemeProvider>
      <div className="landing">
        <div className="mark">Stello Kitchens</div>
        <h1>{t("landing.title")}</h1>
        <p>{t("landing.body")}</p>
        <LanguageSwitcher />
      </div>
    </ThemeProvider>
  );
}
