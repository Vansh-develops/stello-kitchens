import { useEffect, useState } from "react";
import type { TokenBoardDto } from "@stello/shared";
import { api } from "./api";
import { ThemeProvider } from "./ThemeProvider";
import { InstallPrompt } from "./InstallPrompt";
import { LanguageSwitcher, useT } from "./i18n";

// Customer-facing token-display screen (a TV near the counter). Polls the board
// and shows which token numbers are cooking vs ready for pickup.
export function Board({ token }: { token: string }) {
  const [board, setBoard] = useState<TokenBoardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .board(token)
        .then((b) => alive && setBoard(b))
        .catch((e) => alive && setError(e instanceof Error ? e.message : t("board.unavailable")));
    load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [token]);

  if (error)
    return (
      <ThemeProvider themeId={board?.themeId}>
        <div className="board err-board">{error}</div>
      </ThemeProvider>
    );
  if (!board)
    return (
      <ThemeProvider>
        <div className="board">{t("board.loading")}</div>
      </ThemeProvider>
    );

  return (
    <ThemeProvider themeId={board?.themeId}>
      <div className="board">
        <header className="board-head">
          <span className="mark">{board.outletName}</span>
          <span className="board-sub">{t("board.status")}</span>
          <LanguageSwitcher />
        </header>
        <div className="board-cols">
          <section className="col preparing">
            <h2>{t("board.preparing")}</h2>
            <div className="tokens">
              {board.preparing.length === 0 ? (
                <span className="none">—</span>
              ) : (
                board.preparing.map((n) => (
                  <span key={n} className="tok">
                    {n}
                  </span>
                ))
              )}
            </div>
          </section>
          <section className="col ready">
            <h2>{t("board.ready")}</h2>
            <div className="tokens">
              {board.ready.length === 0 ? (
                <span className="none">—</span>
              ) : (
                board.ready.map((n) => (
                  <span key={n} className="tok flash">
                    {n}
                  </span>
                ))
              )}
            </div>
          </section>
        </div>
        <InstallPrompt placement="board" />
      </div>
    </ThemeProvider>
  );
}
