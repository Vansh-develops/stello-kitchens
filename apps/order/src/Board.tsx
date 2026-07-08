import { useEffect, useState } from "react";
import type { TokenBoardDto } from "@stello/shared";
import { api } from "./api";
import { ThemeProvider } from "./ThemeProvider";

// Customer-facing token-display screen (a TV near the counter). Polls the board
// and shows which token numbers are cooking vs ready for pickup.
export function Board({ token }: { token: string }) {
  const [board, setBoard] = useState<TokenBoardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .board(token)
        .then((b) => alive && setBoard(b))
        .catch((e) => alive && setError(e instanceof Error ? e.message : "Board unavailable"));
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
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
        <div className="board">Loading…</div>
      </ThemeProvider>
    );

  return (
    <ThemeProvider themeId={board?.themeId}>
      <div className="board">
        <header className="board-head">
          <span className="mark">{board.outletName}</span>
          <span className="board-sub">Order status</span>
        </header>
        <div className="board-cols">
          <section className="col preparing">
            <h2>Preparing</h2>
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
            <h2>Ready to collect</h2>
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
      </div>
    </ThemeProvider>
  );
}
