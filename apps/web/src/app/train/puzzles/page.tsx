"use client";

/**
 * Tactics puzzle trainer. Puzzles come from the server (Lichess CC0 set):
 * a FEN plus a UCI solution line whose first move is the opponent's setup,
 * played automatically. The solver answers the rest; each move is validated
 * against the line (an alternate checkmate is also accepted).
 *
 * Two modes:
 *   Practice - one puzzle near your tactics rating (optionally by theme);
 *              solving/failing updates the rating server-side.
 *   Rush     - a 3-strikes sprint with ramping difficulty; a game, so it does
 *              not touch your rating. Best score is kept in localStorage.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import {
  api, Puzzle, PuzzleAttemptResult, PuzzleStats, PuzzleTheme,
} from "@/lib/api";

type Status = "loading" | "intro" | "solving" | "opponent" | "solved" | "failed";
type Mode = "practice" | "rush";

const RUSH_STRIKES = 3;
const rushRating = (score: number) => Math.min(2400, 900 + score * 25);

function uciToMove(uci: string) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined };
}

export default function PuzzlesPage() {
  const router = useRouter();
  const game = useRef(new Chess());
  const puzzleRef = useRef<Puzzle | null>(null);
  const modeRef = useRef<Mode>("practice");
  const themeRef = useRef("");
  const scoreRef = useRef(0);
  const strikesRef = useRef(0);

  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [fen, setFen] = useState(game.current.fen());
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [solIdx, setSolIdx] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [feedback, setFeedback] = useState<PuzzleAttemptResult | null>(null);
  const [expectedSan, setExpectedSan] = useState<string | null>(null);
  const [stats, setStats] = useState<PuzzleStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("practice");
  const [theme, setTheme] = useState("");
  const [themes, setThemes] = useState<PuzzleTheme[]>([]);
  const [rushActive, setRushActive] = useState(false);
  const [rush, setRush] = useState({ score: 0, strikes: 0 });
  const [rushResult, setRushResult] = useState<number | null>(null);
  const [rushBest, setRushBest] = useState(0);

  const loadPuzzle = useCallback(async (ratingOverride?: number) => {
    setStatus("loading");
    setFeedback(null);
    setExpectedSan(null);
    try {
      const p = await api.nextPuzzle({
        theme: modeRef.current === "practice" && themeRef.current ? themeRef.current : undefined,
        rating: ratingOverride,
      });
      const g = new Chess(p.fen);
      game.current = g;
      puzzleRef.current = p;
      // FEN's side to move is the opponent (they play moves[0]); solver is the other side.
      const solver = g.turn() === "w" ? "black" : "white";
      setOrientation(solver);
      setPuzzle(p);
      setFen(g.fen());
      setSolIdx(0);
      setStatus("intro");
      setTimeout(() => {
        g.move(uciToMove(p.moves[0]));
        setFen(g.fen());
        setSolIdx(1);
        setStatus("solving");
      }, 600);
    } catch (e) {
      setError(
        (e as { message?: string })?.message ??
          "Could not load a puzzle. Have puzzles been loaded on the server?"
      );
      setStatus("loading");
    }
  }, []);

  useEffect(() => {
    setRushBest(Number(localStorage.getItem("rushBest") || 0));
    api.puzzleStats().then(setStats).catch(() => router.push("/login"));
    api.puzzleThemes().then(setThemes).catch(() => {});
    loadPuzzle();
  }, [loadPuzzle, router]);

  const finish = useCallback(
    async (solved: boolean) => {
      if (!puzzleRef.current) return;

      if (modeRef.current === "rush") {
        if (solved) scoreRef.current += 1;
        else strikesRef.current += 1;
        setRush({ score: scoreRef.current, strikes: strikesRef.current });
        setStatus(solved ? "solved" : "failed");

        if (strikesRef.current >= RUSH_STRIKES) {
          const best = Math.max(rushBest, scoreRef.current);
          localStorage.setItem("rushBest", String(best));
          setRushBest(best);
          setRushResult(scoreRef.current);
          setRushActive(false);
          return;
        }
        setTimeout(() => loadPuzzle(rushRating(scoreRef.current)), solved ? 450 : 800);
        return;
      }

      // Practice: record the attempt and nudge the rating.
      setStatus(solved ? "solved" : "failed");
      try {
        const res = await api.attemptPuzzle(puzzleRef.current.id, solved);
        setFeedback(res);
        api.puzzleStats().then(setStats).catch(() => {});
      } catch {
        /* rating update is best-effort */
      }
    },
    [loadPuzzle, rushBest]
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

  function switchMode(m: Mode) {
    modeRef.current = m;
    setMode(m);
    setRushActive(false);
    setRushResult(null);
    if (m === "practice") loadPuzzle();
  }

  function startRush() {
    scoreRef.current = 0;
    strikesRef.current = 0;
    setRush({ score: 0, strikes: 0 });
    setRushResult(null);
    setRushActive(true);
    loadPuzzle(rushRating(0));
  }

  function pickTheme(t: string) {
    themeRef.current = t;
    setTheme(t);
    loadPuzzle();
  }

  const solving = status === "solving" || status === "opponent" || status === "intro";
  const showBoard = mode === "practice" || rushActive;

  return (
    <div className="min-h-screen p-4 max-w-5xl mx-auto">
      <header className="flex items-center gap-3 mb-4 flex-wrap">
        <Link href="/app" className="btn">← Board</Link>
        <Link href="/train" className="btn">♞ Repertoire</Link>
        <h1 className="text-xl font-bold">🧩 Puzzles</h1>
        {mode === "practice" && stats && (
          <span className="ml-auto flex items-center gap-4 text-sm">
            <span>
              <span className="text-muted">Rating </span>
              <span className="text-accent font-bold text-lg font-mono">
                {stats.puzzle_rating}
              </span>
            </span>
            <span className="text-muted">{stats.solved}/{stats.attempted} solved</span>
            {stats.streak > 0 && <span title="Current solved streak">🔥 {stats.streak}</span>}
          </span>
        )}
        {mode === "rush" && rushActive && (
          <span className="ml-auto flex items-center gap-4 text-sm">
            <span>
              <span className="text-muted">Score </span>
              <span className="text-accent font-bold text-lg font-mono">{rush.score}</span>
            </span>
            <span className="flex gap-1" title="Strikes">
              {Array.from({ length: RUSH_STRIKES }).map((_, i) => (
                <span key={i} className={i < rush.strikes ? "text-red-400" : "text-muted"}>
                  ✗
                </span>
              ))}
            </span>
          </span>
        )}
      </header>

      {/* Mode tabs */}
      <div className="flex gap-1 mb-3 text-sm">
        {(["practice", "rush"] as const).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`px-3 py-1 rounded ${
              mode === m ? "bg-accent text-black font-semibold" : "bg-panelAlt text-muted hover:text-ink"
            }`}
          >
            {m === "practice" ? "Practice" : "⚡ Puzzle Rush"}
          </button>
        ))}
        {mode === "practice" && themes.length > 0 && (
          <select
            className="input text-sm ml-2 w-48"
            value={theme}
            onChange={(e) => pickTheme(e.target.value)}
            title="Filter by tactical theme"
          >
            <option value="">Any theme</option>
            {themes.map((t) => (
              <option key={t.theme} value={t.theme}>
                {t.theme} ({t.count.toLocaleString()})
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-400 mb-3 cursor-pointer" onClick={() => setError(null)}>
          {error} (dismiss)
        </p>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        {showBoard && (
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
        )}

        <aside className="flex-1 space-y-3">
          {/* Rush start / game-over card */}
          {mode === "rush" && !rushActive && (
            <div className="bg-panelAlt rounded p-6 text-center space-y-3">
              {rushResult !== null ? (
                <>
                  <p className="text-2xl font-bold text-accent">Rush over!</p>
                  <p className="text-lg">
                    Score <span className="font-mono font-bold">{rushResult}</span>
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold">⚡ Puzzle Rush</p>
                  <p className="text-sm text-muted">
                    Solve as many as you can. {RUSH_STRIKES} strikes and you&apos;re out.
                    Difficulty climbs as you go. Doesn&apos;t affect your rating.
                  </p>
                </>
              )}
              <p className="text-sm text-muted">Best: <span className="font-mono">{rushBest}</span></p>
              <button className="btn-primary" onClick={startRush} autoFocus>
                {rushResult !== null ? "Play again" : "Start"}
              </button>
            </div>
          )}

          {/* Prompt while solving (both modes) */}
          {showBoard && solving && (
            <div className="bg-panelAlt rounded p-4">
              <p className="text-lg font-semibold flex items-center gap-2">
                <span
                  className={`w-4 h-4 rounded-full border border-white/40 ${
                    orientation === "white" ? "bg-white" : "bg-black"
                  }`}
                />
                Your move — best line for {orientation}
              </p>
              <p className="text-xs text-muted mt-1">
                {status === "intro" ? "…" : status === "opponent" ? "Opponent is replying…" : "Drag the winning move."}
              </p>
            </div>
          )}

          {/* Rush verdict flash (no reveal, auto-advances) */}
          {mode === "rush" && rushActive && (status === "solved" || status === "failed") && (
            <div className={`rounded p-4 ${status === "solved" ? "bg-accent/20" : "bg-red-500/20"}`}>
              <p className="text-lg font-semibold">
                {status === "solved" ? "✓ Correct" : "✗ Strike"}
              </p>
              <p className="text-xs text-muted mt-1">Next puzzle…</p>
            </div>
          )}

          {/* Practice verdicts */}
          {mode === "practice" && status === "solved" && feedback && (
            <div className="bg-accent/20 rounded p-4">
              <p className="text-lg font-semibold text-accent">✓ Solved!</p>
              <RatingLine feedback={feedback} />
            </div>
          )}
          {mode === "practice" && status === "failed" && feedback && (
            <div className="bg-red-500/20 rounded p-4">
              <p className="text-lg font-semibold text-red-300">✗ Not quite</p>
              {expectedSan && (
                <p className="text-sm mt-1">
                  The move was <span className="font-mono font-bold">{expectedSan}</span>.
                </p>
              )}
              <RatingLine feedback={feedback} />
            </div>
          )}
          {mode === "practice" && (status === "solved" || status === "failed") && (
            <button className="btn-primary w-full" onClick={() => loadPuzzle()} autoFocus>
              Next puzzle →
            </button>
          )}
          {mode === "practice" && puzzle && (status === "solved" || status === "failed") && (
            <div className="bg-panelAlt rounded p-3 text-xs text-muted space-y-1">
              <div>Puzzle rating <span className="text-ink font-mono">{puzzle.rating}</span></div>
              {puzzle.themes.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {puzzle.themes.map((t) => (
                    <span key={t} className="bg-white/5 rounded px-1.5 py-0.5">{t}</span>
                  ))}
                </div>
              )}
              {puzzle.game_url && (
                <a href={puzzle.game_url} target="_blank" rel="noreferrer" className="text-accent hover:underline inline-block">
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
        ({up ? "+" : ""}{feedback.delta})
      </span>
    </p>
  );
}
