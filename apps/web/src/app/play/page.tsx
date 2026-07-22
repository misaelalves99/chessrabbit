"use client";

/**
 * Play a full game against Stockfish. Pick a colour and a strength level (1-8),
 * then move by drag or click; the server replies with the engine's move at the
 * chosen Skill Level. chess.js enforces legality and detects game end.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { api, getAccessToken } from "@/lib/api";
import { useClickToMove } from "@/hooks/useClickToMove";

type Status = "setup" | "playing" | "over";
type Color = "white" | "black";

const LEVEL_HINT: Record<number, string> = {
  1: "Beginner", 2: "Beginner", 3: "Casual", 4: "Casual",
  5: "Intermediate", 6: "Intermediate", 7: "Strong", 8: "Full strength",
};

function uciToMove(uci: string) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || "q" };
}

const HINT_STYLE = { background: "rgba(255, 213, 79, 0.55)" };

export default function PlayPage() {
  const router = useRouter();
  const game = useRef(new Chess());
  const colorRef = useRef<Color>("white");
  const levelRef = useRef(4);

  const [fen, setFen] = useState(game.current.fen());
  const [moves, setMoves] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("setup");
  const [orientation, setOrientation] = useState<Color>("white");
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ from: string; to: string; san: string } | null>(null);
  const [hinting, setHinting] = useState(false);

  // Setup form
  const [color, setColor] = useState<Color | "random">("white");
  const [level, setLevel] = useState(4);

  useEffect(() => {
    if (!getAccessToken()) router.push("/login");
  }, [router]);

  // A hint belongs to one position - drop it as soon as the board changes.
  useEffect(() => {
    setHint(null);
  }, [fen]);

  const sync = useCallback(() => {
    setFen(game.current.fen());
    setMoves(game.current.history());
  }, []);

  const finishIfOver = useCallback((): boolean => {
    const g = game.current;
    if (!g.isGameOver()) return false;
    let msg: string;
    if (g.isCheckmate()) {
      const userIsLoser = g.turn() === (colorRef.current === "white" ? "w" : "b");
      msg = userIsLoser ? "Checkmate — Stockfish wins." : "Checkmate — you win! 🎉";
    } else if (g.isStalemate()) {
      msg = "Draw — stalemate.";
    } else if (g.isThreefoldRepetition()) {
      msg = "Draw — threefold repetition.";
    } else if (g.isInsufficientMaterial()) {
      msg = "Draw — insufficient material.";
    } else {
      msg = "Draw — fifty-move rule.";
    }
    setResult(msg);
    setStatus("over");
    setThinking(false);
    return true;
  }, []);

  const requestEngineMove = useCallback(async () => {
    setThinking(true);
    try {
      const res = await api.playMove(game.current.fen(), levelRef.current);
      if (!res.move || res.game_over) {
        if (!finishIfOver()) setThinking(false);
        return;
      }
      game.current.move(uciToMove(res.move));
      sync();
      if (!finishIfOver()) setThinking(false);
    } catch {
      setError("The engine could not respond. Check the connection and try again.");
      setThinking(false);
    }
  }, [finishIfOver, sync]);

  const onMove = useCallback(
    (from: string, to: string): boolean => {
      if (status !== "playing" || thinking) return false;
      const g = game.current;
      if (g.turn() !== (colorRef.current === "white" ? "w" : "b")) return false;
      let move;
      try {
        move = g.move({ from, to, promotion: "q" });
      } catch {
        return false;
      }
      if (!move) return false;
      sync();
      if (!finishIfOver()) void requestEngineMove();
      return true;
    },
    [status, thinking, sync, finishIfOver, requestEngineMove],
  );

  // A hint is the engine's best move (full strength) for the current position.
  const requestHint = useCallback(async () => {
    if (hinting) return;
    const atFen = game.current.fen();
    setHinting(true);
    try {
      const res = await api.playMove(atFen, 8);
      if (res.move && game.current.fen() === atFen) {
        const probe = new Chess(atFen);
        const mv = probe.move(uciToMove(res.move));
        setHint({
          from: res.move.slice(0, 2),
          to: res.move.slice(2, 4),
          san: mv?.san ?? res.move,
        });
      }
    } catch {
      setError("Could not get a hint right now.");
    } finally {
      setHinting(false);
    }
  }, [hinting]);

  const isUserTurn = game.current.turn() === (orientation === "white" ? "w" : "b");
  const canMove = status === "playing" && !thinking && isUserTurn;
  const { onSquareClick, squareStyles } = useClickToMove(fen, onMove, canMove);

  const hintStyles = hint ? { [hint.from]: HINT_STYLE, [hint.to]: HINT_STYLE } : {};

  function startGame() {
    const c: Color = color === "random" ? (Math.random() < 0.5 ? "white" : "black") : color;
    colorRef.current = c;
    levelRef.current = level;
    game.current = new Chess();
    setOrientation(c);
    setResult(null);
    setError(null);
    setStatus("playing");
    sync();
    if (c === "black") void requestEngineMove(); // engine (White) opens
  }

  function newGame() {
    game.current = new Chess();
    sync();
    setResult(null);
    setError(null);
    setThinking(false);
    setStatus("setup");
  }

  function resign() {
    setResult("You resigned — Stockfish wins.");
    setStatus("over");
    setThinking(false);
  }

  return (
    <div className="min-h-screen p-4 max-w-5xl mx-auto">
      <header className="flex items-center gap-3 mb-4 flex-wrap">
        <Link href="/app" className="btn">← Board</Link>
        <h1 className="font-display text-xl font-bold">♟ Play vs Stockfish</h1>
        {status !== "setup" && (
          <span className="ml-auto text-sm text-muted">
            You play {orientation} · Level {levelRef.current}
          </span>
        )}
      </header>

      {error && (
        <p className="text-sm text-red-400 mb-3 cursor-pointer" onClick={() => setError(null)}>
          {error} (dismiss)
        </p>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="w-[min(92vw,480px)] shrink-0">
          <Chessboard
            position={fen}
            onPieceDrop={onMove}
            onSquareClick={onSquareClick}
            boardOrientation={orientation}
            arePiecesDraggable={canMove}
            customBoardStyle={{ borderRadius: "4px" }}
            customDarkSquareStyle={{ backgroundColor: "#8CA2AD" }}
            customLightSquareStyle={{ backgroundColor: "#DCE1E7" }}
            customSquareStyles={{ ...hintStyles, ...squareStyles }}
          />
        </div>

        <aside className="flex-1 space-y-4 min-w-[260px]">
          {status === "setup" && (
            <div className="bg-panelAlt rounded p-4 space-y-4">
              <div>
                <p className="text-sm font-semibold mb-2">Play as</p>
                <div className="flex gap-2">
                  {(["white", "black", "random"] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => setColor(c)}
                      className={`px-3 py-1 rounded text-sm capitalize ${
                        color === c ? "bg-accent text-black font-semibold" : "bg-white/5 text-muted hover:text-ink"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold mb-2">
                  Level <span className="text-accent">{level}</span>{" "}
                  <span className="text-muted font-normal">· {LEVEL_HINT[level]}</span>
                </p>
                <input
                  type="range"
                  min={1}
                  max={8}
                  value={level}
                  onChange={(e) => setLevel(Number(e.target.value))}
                  className="w-full accent-accent"
                />
                <div className="flex justify-between text-[10px] text-muted px-0.5">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <span key={n}>{n}</span>
                  ))}
                </div>
              </div>

              <button className="btn-primary w-full" onClick={startGame}>
                Start game
              </button>
            </div>
          )}

          {status !== "setup" && (
            <div className="bg-panelAlt rounded p-4">
              {status === "over" ? (
                <p className="text-lg font-semibold">{result}</p>
              ) : thinking ? (
                <p className="text-lg font-semibold animate-pulse">Stockfish is thinking…</p>
              ) : (
                <div>
                  <p className="text-lg font-semibold flex items-center gap-2">
                    <span
                      className={`w-4 h-4 rounded-full border border-white/40 ${
                        orientation === "white" ? "bg-white" : "bg-black"
                      }`}
                    />
                    Your move
                  </p>
                  {hint && (
                    <p className="text-sm text-yellow-300 mt-1">
                      Hint: <span className="font-mono font-semibold">{hint.san}</span>
                    </p>
                  )}
                </div>
              )}
              <div className="flex gap-2 mt-3">
                {canMove && (
                  <button className="btn flex-1" onClick={requestHint} disabled={hinting}>
                    {hinting ? "…" : "💡 Hint"}
                  </button>
                )}
                {status === "playing" && (
                  <button className="btn flex-1" onClick={resign}>
                    Resign
                  </button>
                )}
                <button className="btn-primary flex-1" onClick={newGame}>
                  New game
                </button>
              </div>
            </div>
          )}

          {/* Move list */}
          {moves.length > 0 && (
            <div className="bg-panelAlt rounded p-3 max-h-64 overflow-auto">
              <div className="grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5 text-sm font-mono">
                {Array.from({ length: Math.ceil(moves.length / 2) }).map((_, i) => (
                  <div key={i} className="contents">
                    <span className="text-muted">{i + 1}.</span>
                    <span>{moves[i * 2]}</span>
                    <span>{moves[i * 2 + 1] ?? ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
