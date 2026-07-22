"use client";

/**
 * Tactics puzzle trainer. Puzzles come from the server (Lichess CC0 set):
 * a FEN plus a UCI solution line whose first move is the opponent's setup,
 * played automatically. The solver answers the rest; each move is validated
 * against the line (an alternate checkmate is also accepted). Solving or
 * failing updates the player's tactics rating server-side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { api, Puzzle, PuzzleAttemptResult, PuzzleStats } from "@/lib/api";

type Status = "loading" | "intro" | "solving" | "opponent" | "solved" | "failed";

function uciToMove(uci: string) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined };
}

export default function PuzzlesPage() {
  const router = useRouter();
  const game = useRef(new Chess());
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [fen, setFen] = useState(game.current.fen());
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [solIdx, setSolIdx] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [feedback, setFeedback] = useState<PuzzleAttemptResult | null>(null);
  const [expectedSan, setExpectedSan] = useState<string | null>(null);
  const [stats, setStats] = useState<PuzzleStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPuzzle = useCallback(async () => {
    setStatus("loading");
    setFeedback(null);
    setExpectedSan(null);
    try {
      const p = await api.nextPuzzle();
      const g = new Chess(p.fen);
      game.current = g;
      // FEN's side to move is the opponent (they play moves[0]); solver is the other side.
      const solver = g.turn() === "w" ? "black" : "white";
      setOrientation(solver);
      setPuzzle(p);
      setFen(g.fen());
      setSolIdx(0);
      setStatus("intro");
      // Play the setup move after a beat so the solver sees it happen.
      setTimeout(() => {
        g.move(uciToMove(p.moves[0]));
        setFen(g.fen());
        setSolIdx(1);
        setStatus("solving");
      }, 650);
    } catch (e) {
      setError(
        (e as { message?: string })?.message ??
          "Could not load a puzzle. Have puzzles been loaded on the server?"
      );
      setStatus("loading");
    }
  }, []);

  useEffect(() => {
    api.puzzleStats().then(setStats).catch(() => router.push("/login"));
    loadPuzzle();
  }, [loadPuzzle, router]);

  const finish = useCallback(
    async (solved: boolean) => {
      setStatus(solved ? "solved" : "failed");
      if (!puzzle) return;
      try {
        const res = await api.attemptPuzzle(puzzle.id, solved);
        setFeedback(res);
        api.puzzleStats().then(setStats).catch(() => {});
      } catch {
        /* rating update is best-effort */
      }
    },
    [puzzle]
  );

  const onDrop = useCallback(
    (from: string, to: string): boolean => {
      if (status !== "solving" || !puzzle) return false;
      const g = game.current;
      let move;
      try {
        move = g.move({ from, to, promotion: "q" });
      } catch {
        return false;
      }
      if (!move) return false;

      const expected = puzzle.moves[solIdx];
      const playedUci = move.from + move.to + (move.promotion ?? "");
      const correct = playedUci === expected || g.isCheckmate();

      if (!correct) {
        g.undo();
        // Reveal the move they should have found.
        const tmp = new Chess(g.fen());
        try {
          setExpectedSan(tmp.move(uciToMove(expected))?.san ?? expected);
        } catch {
          setExpectedSan(expected);
        }
        setFen(g.fen());
        void finish(false);
        return false;
      }

      setFen(g.fen());
      const nextIdx = solIdx + 1;
      if (g.isCheckmate() || nextIdx >= puzzle.moves.length) {
        void finish(true);
        return true;
      }

      // Opponent's reply, then back to the solver.
      setStatus("opponent");
      setSolIdx(nextIdx);
      setTimeout(() => {
        g.move(uciToMove(puzzle.moves[nextIdx]));
        setFen(g.fen());
        setSolIdx(nextIdx + 1);
        setStatus("solving");
      }, 350);
      return true;
    },
    [status, puzzle, solIdx, finish]
  );

  const solving = status === "solving" || status === "opponent" || status === "intro";

  return (
    <div className="min-h-screen p-4 max-w-5xl mx-auto">
      <header className="flex items-center gap-4 mb-4 flex-wrap">
        <Link href="/app" className="btn">← Board</Link>
        <Link href="/train" className="btn">♞ Repertoire</Link>
        <h1 className="text-xl font-bold">🧩 Puzzles</h1>
        {stats && (
          <span className="ml-auto flex items-center gap-4 text-sm">
            <span>
              <span className="text-muted">Rating </span>
              <span className="text-accent font-bold text-lg font-mono">
                {stats.puzzle_rating}
              </span>
            </span>
            <span className="text-muted">
              {stats.solved}/{stats.attempted} solved
            </span>
            {stats.streak > 0 && (
              <span title="Current solved streak">🔥 {stats.streak}</span>
            )}
          </span>
        )}
      </header>

      {error && (
        <p className="text-sm text-red-400 mb-3 cursor-pointer" onClick={() => setError(null)}>
          {error} (dismiss)
        </p>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="w-[min(92vw,440px)] shrink-0">
          <Chessboard
            position={fen}
            onPieceDrop={onDrop}
            boardOrientation={orientation}
            arePiecesDraggable={status === "solving"}
            customBoardStyle={{ borderRadius: "4px" }}
            customDarkSquareStyle={{ backgroundColor: "#739552" }}
            customLightSquareStyle={{ backgroundColor: "#EBECD0" }}
          />
        </div>

        <aside className="flex-1 space-y-3">
          {/* Prompt / verdict */}
          {solving && (
            <div className="bg-panelAlt rounded p-4">
              <p className="text-lg font-semibold flex items-center gap-2">
                <span
                  className={`w-4 h-4 rounded-full border border-white/40 ${
                    orientation === "white" ? "bg-white" : "bg-black"
                  }`}
                />
                Your move — find the best line for {orientation}
              </p>
              <p className="text-xs text-muted mt-1">
                {status === "intro"
                  ? "…"
                  : status === "opponent"
                    ? "Opponent is replying…"
                    : "Drag the winning move."}
              </p>
            </div>
          )}

          {status === "solved" && feedback && (
            <div className="bg-accent/20 rounded p-4">
              <p className="text-lg font-semibold text-accent">✓ Solved!</p>
              <RatingLine feedback={feedback} />
            </div>
          )}

          {status === "failed" && feedback && (
            <div className="bg-red-500/20 rounded p-4">
              <p className="text-lg font-semibold text-red-300">✗ Not quite</p>
              {expectedSan && (
                <p className="text-sm mt-1">
                  The move was{" "}
                  <span className="font-mono font-bold">{expectedSan}</span>.
                </p>
              )}
              <RatingLine feedback={feedback} />
            </div>
          )}

          {(status === "solved" || status === "failed") && (
            <button className="btn-primary w-full" onClick={loadPuzzle} autoFocus>
              Next puzzle →
            </button>
          )}

          {/* Puzzle meta (rating/themes revealed after the attempt, Lichess-style) */}
          {puzzle && (status === "solved" || status === "failed") && (
            <div className="bg-panelAlt rounded p-3 text-xs text-muted space-y-1">
              <div>
                Puzzle rating <span className="text-ink font-mono">{puzzle.rating}</span>
              </div>
              {puzzle.themes.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {puzzle.themes.map((t) => (
                    <span key={t} className="bg-white/5 rounded px-1.5 py-0.5">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {puzzle.game_url && (
                <a
                  href={puzzle.game_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline inline-block"
                >
                  From this Lichess game ↗
                </a>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function RatingLine({ feedback }: { feedback: PuzzleAttemptResult }) {
  const up = feedback.delta >= 0;
  return (
    <p className="text-sm mt-2">
      Your rating: <span className="font-mono">{feedback.rating_after}</span>{" "}
      <span className={up ? "text-accent" : "text-red-300"}>
        ({up ? "+" : ""}
        {feedback.delta})
      </span>
    </p>
  );
}
