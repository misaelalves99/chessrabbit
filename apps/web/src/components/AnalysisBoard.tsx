"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useEngine, formatEval } from "@/hooks/useEngine";
import { Annotation, api, ExplorerMove, ReviewSummary } from "@/lib/api";
import ReviewPanel, { CLASS_META } from "@/components/ReviewPanel";

interface Props {
  initialPgn?: string;
  gameLabel?: string;
  gameId?: number;
  initialAnnotations?: Annotation[];
}

export default function AnalysisBoard({
  initialPgn,
  gameLabel,
  gameId,
  initialAnnotations,
}: Props) {
  // `game` is the authoritative position; history drives the move list.
  const [game, setGame] = useState(() => new Chess());
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0); // ply index; 0 = start position
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [explorer, setExplorer] = useState<ExplorerMove[]>([]);
  const [explorerTotal, setExplorerTotal] = useState(0);
  const [explorerScope, setExplorerScope] = useState<"reference" | "mine">("reference");
  const [autoAnalyse, setAutoAnalyse] = useState(true);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const engine = useEngine();

  // Adopt annotations (and stop any stale poll) when a different game loads
  useEffect(() => {
    setAnnotations(initialAnnotations ?? []);
    setReviewSummary(null);
    setReviewing(false);
    if (pollRef.current) clearInterval(pollRef.current);
  }, [gameId, initialAnnotations]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const runReview = useCallback(async () => {
    if (!gameId || reviewing) return;
    setReviewing(true);
    try {
      const { job_id } = await api.analyseGame(gameId);
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.getJob(job_id);
          if (job.status === "done" || job.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            setReviewing(false);
            if (job.status === "done" && job.result) {
              setReviewSummary(job.result as ReviewSummary);
              const detail = await api.getGame(gameId);
              setAnnotations(detail.annotations);
            }
          }
        } catch {
          /* transient poll error - keep polling */
        }
      }, 2000);
    } catch {
      setReviewing(false);
    }
  }, [gameId, reviewing]);

  const annByPly = useMemo(() => {
    const m = new Map<number, Annotation>();
    for (const a of annotations) if (a.classification) m.set(a.ply, a);
    return m;
  }, [annotations]);

  // Load an initial PGN once on mount
  useEffect(() => {
    if (!initialPgn) return;
    const g = new Chess();
    try {
      g.loadPgn(initialPgn);
      setHistory(g.history());
      const fresh = new Chess();
      setGame(fresh);
      setCursor(0);
    } catch {
      /* malformed pgn - keep empty board */
    }
  }, [initialPgn]);

  // Rebuild the board position for the current cursor
  const positionAt = useCallback(
    (ply: number) => {
      const g = new Chess();
      for (let i = 0; i < ply && i < history.length; i++) {
        try {
          g.move(history[i]);
        } catch {
          break;
        }
      }
      return g;
    },
    [history]
  );

  const board = useMemo(() => positionAt(cursor), [positionAt, cursor]);
  const fen = board.fen();

  // Ask the engine + explorer whenever the position changes
  useEffect(() => {
    if (autoAnalyse && engine.connected) {
      engine.analyse(fen, 22, 3);
    }
    api
      .explorer(fen, explorerScope)
      .then((res) => {
        setExplorer(res.moves);
        setExplorerTotal(res.total_games);
      })
      .catch(() => {
        setExplorer([]);
        setExplorerTotal(0);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, engine.connected, autoAnalyse]);

  // Playing a move from the current cursor truncates any future moves
  const onDrop = useCallback(
    (from: string, to: string) => {
      const g = positionAt(cursor);
      let move;
      try {
        move = g.move({ from, to, promotion: "q" });
      } catch {
        return false;
      }
      if (!move) return false;

      const next = [...history.slice(0, cursor), move.san];
      setHistory(next);
      setCursor(next.length);
      return true;
    },
    [cursor, history, positionAt]
  );

  // Keyboard navigation, like every serious chess GUI
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setCursor((c) => Math.max(0, c - 1));
      if (e.key === "ArrowRight") setCursor((c) => Math.min(history.length, c + 1));
      if (e.key === "ArrowUp") setCursor(0);
      if (e.key === "ArrowDown") setCursor(history.length);
      if (e.key === "f") setOrientation((o) => (o === "white" ? "black" : "white"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history.length]);

  const best = engine.lines[0];
  const evalText = formatEval(best);
  const whiteAdvantage = (best?.cp ?? 0) >= 0;

  // Eval bar height: clamp centipawns to a readable range
  const barPct = useMemo(() => {
    if (best?.mate != null) return best.mate > 0 ? 100 : 0;
    const cp = best?.cp ?? 0;
    return Math.max(2, Math.min(98, 50 + cp / 20));
  }, [best]);

  return (
    <div className="flex flex-col lg:flex-row gap-4 p-4 bg-panel min-h-screen text-ink">
      {/* ---------- Board column ---------- */}
      <div className="flex gap-2">
        {/* Eval bar */}
        <div className="w-6 h-[min(92vw,480px)] bg-black rounded overflow-hidden flex flex-col-reverse shrink-0">
          <div
            className="bg-white transition-all duration-300"
            style={{ height: `${barPct}%` }}
          />
        </div>

        <div>
          <div className="w-[min(92vw,480px)]">
            <Chessboard
              position={fen}
              onPieceDrop={onDrop}
              boardOrientation={orientation}
              customBoardStyle={{ borderRadius: "4px" }}
              customDarkSquareStyle={{ backgroundColor: "#739552" }}
              customLightSquareStyle={{ backgroundColor: "#EBECD0" }}
            />
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2 mt-3">
            <button onClick={() => setCursor(0)} className="btn">⏮</button>
            <button onClick={() => setCursor((c) => Math.max(0, c - 1))} className="btn">◀</button>
            <button
              onClick={() => setCursor((c) => Math.min(history.length, c + 1))}
              className="btn"
            >
              ▶
            </button>
            <button onClick={() => setCursor(history.length)} className="btn">⏭</button>
            <button
              onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
              className="btn"
            >
              ⟳ Flip
            </button>
            <span className="ml-auto text-xs text-muted">
              ply {cursor}/{history.length}
            </span>
          </div>
        </div>
      </div>

      {/* ---------- Right panel ---------- */}
      <div className="flex-1 flex flex-col gap-4 min-w-[320px] max-w-[560px]">
        {gameLabel && (
          <div className="text-sm text-muted border-b border-white/10 pb-2">
            {gameLabel}
          </div>
        )}

        {/* Engine pane */}
        <section className="bg-panelAlt rounded p-3">
          <header className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">Engine</span>
              <span
                className={`w-2 h-2 rounded-full ${
                  engine.connected ? "bg-accent" : "bg-red-500"
                }`}
                title={engine.connected ? "connected" : "disconnected"}
              />
              {engine.thinking && (
                <span className="text-xs text-muted animate-pulse">thinking…</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`font-mono text-lg ${
                  whiteAdvantage ? "text-white" : "text-red-400"
                }`}
              >
                {evalText}
              </span>
              <span className="text-xs text-muted">d{engine.depth}</span>
            </div>
          </header>

          <label className="flex items-center gap-2 text-xs text-muted mb-2">
            <input
              type="checkbox"
              checked={autoAnalyse}
              onChange={(e) => setAutoAnalyse(e.target.checked)}
            />
            Auto-analyse on move
          </label>

          {engine.error && (
            <div className="text-xs text-red-400 mb-2">{engine.error}</div>
          )}

          <ol className="space-y-1">
            {engine.lines.map((line) => (
              <li key={line.multipv} className="text-xs font-mono flex gap-2">
                <span className="text-accent w-12 shrink-0">
                  {formatEval(line)}
                </span>
                <span className="text-muted truncate">{line.pv.slice(0, 8).join(" ")}</span>
              </li>
            ))}
            {engine.lines.length === 0 && (
              <li className="text-xs text-muted">No analysis yet.</li>
            )}
          </ol>
        </section>

        {/* Game review */}
        <ReviewPanel
          history={history}
          annotations={annotations}
          summary={reviewSummary}
          cursor={cursor}
          onSeek={setCursor}
          reviewing={reviewing}
          onRun={runReview}
          canRun={gameId != null}
        />

        {/* Move list */}
        <section className="bg-panelAlt rounded p-3 flex-1 overflow-auto max-h-64">
          <h3 className="font-semibold text-sm mb-2">Moves</h3>
          <div className="flex flex-wrap gap-x-2 gap-y-1 text-sm font-mono">
            {history.map((san, i) => {
              const cls = annByPly.get(i)?.classification;
              const meta = cls ? CLASS_META[cls] : null;
              return (
                <span key={i} className="flex items-center gap-1">
                  {i % 2 === 0 && (
                    <span className="text-muted">{Math.floor(i / 2) + 1}.</span>
                  )}
                  <button
                    onClick={() => setCursor(i + 1)}
                    title={annByPly.get(i)?.review ?? undefined}
                    className={`px-1 rounded hover:bg-white/10 ${
                      cursor === i + 1 ? "bg-accent text-black" : meta?.color ?? ""
                    }`}
                  >
                    {san}
                    {meta?.glyph && (
                      <span className="ml-0.5 text-[0.7em] align-super">{meta.glyph}</span>
                    )}
                  </button>
                </span>
              );
            })}
            {history.length === 0 && (
              <span className="text-muted text-xs">
                Drag a piece to start a line.
              </span>
            )}
          </div>
        </section>

        {/* Opening explorer */}
        <section className="bg-panelAlt rounded p-3">
          <h3 className="font-semibold text-sm mb-2">
            <span className="mr-2">
              <button
                onClick={() => setExplorerScope("reference")}
                className={explorerScope === "reference" ? "text-accent" : "text-muted hover:text-ink"}
              >
                Masters
              </button>
              {" · "}
              <button
                onClick={() => setExplorerScope("mine")}
                className={explorerScope === "mine" ? "text-accent" : "text-muted hover:text-ink"}
              >
                My games
              </button>
            </span>{" "}
            <span className="text-muted font-normal text-xs">
              {explorerTotal.toLocaleString()} games
            </span>
          </h3>
          {explorer.length === 0 ? (
            <p className="text-xs text-muted">
              No reference games for this position. Load the Lichess database
              (see pipeline/README.md) to populate the explorer.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="text-left font-normal">Move</th>
                  <th className="text-right font-normal">Games</th>
                  <th className="text-left font-normal pl-2">W / D / B</th>
                </tr>
              </thead>
              <tbody>
                {explorer.slice(0, 8).map((m) => (
                  <tr key={m.uci} className="hover:bg-white/5">
                    <td className="font-mono py-0.5">{m.san}</td>
                    <td className="text-right text-muted">
                      {m.games.toLocaleString()}
                    </td>
                    <td className="pl-2">
                      <div className="flex h-3 rounded overflow-hidden w-full min-w-[100px]">
                        <div
                          style={{ width: `${m.white_pct}%` }}
                          className="bg-white"
                          title={`White ${m.white_pct}%`}
                        />
                        <div
                          style={{ width: `${m.draw_pct}%` }}
                          className="bg-gray-500"
                          title={`Draw ${m.draw_pct}%`}
                        />
                        <div
                          style={{ width: `${m.black_pct}%` }}
                          className="bg-black"
                          title={`Black ${m.black_pct}%`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
