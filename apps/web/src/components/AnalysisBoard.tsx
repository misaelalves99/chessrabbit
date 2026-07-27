"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useEngine, formatEval } from "@/hooks/useEngine";
import { useClickToMove } from "@/hooks/useClickToMove";
import { useSquareSize } from "@/hooks/useSquareSize";
import Link from "next/link";
import { Annotation, api, ApiError, ExplorerMove, ExplorerScope, ReviewSummary } from "@/lib/api";
import { CLASS_META } from "@/lib/classification";
import { useBoardTheme } from "@/lib/boardTheme";
import { updateSettings, useSettings } from "@/lib/settings";
import ReviewPanel from "@/components/ReviewPanel";
import EvalBar from "@/components/EvalBar";
import MoveList from "@/components/MoveList";
import EnginePane from "@/components/EnginePane";
import ExplorerPane from "@/components/ExplorerPane";

/** Eval bar width + the gap between it and the board. */
const BOARD_GUTTER = 28;

/**
 * Holding an arrow key walks the game faster than any of this can answer.
 * Waiting for the cursor to settle turns a 40-request burst into one request,
 * and spares the engine 40 abandoned searches.
 */
const SETTLE_MS = 220;

/** Positions keep coming back to the same openings; remembering them makes
    stepping backwards through a game instant. */
const EXPLORER_CACHE_MAX = 300;

type Tab = "review" | "moves" | "engine" | "book";

const TABS: { id: Tab; label: string }[] = [
  { id: "review", label: "Review" },
  { id: "moves", label: "Moves" },
  { id: "engine", label: "Engine" },
  { id: "book", label: "Book" },
];

interface Props {
  initialPgn?: string;
  gameLabel?: string;
  gameId?: number;
  initialAnnotations?: Annotation[];
  /** Ply count the server recorded for this game — see `aligned` below. */
  expectedPlies?: number;
}

export default function AnalysisBoard({
  initialPgn,
  gameLabel,
  gameId,
  initialAnnotations,
  expectedPlies,
}: Props) {
  // `game` is the authoritative position; history drives the move list.
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0); // ply index; 0 = start position
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [explorer, setExplorer] = useState<ExplorerMove[]>([]);
  const [explorerTotal, setExplorerTotal] = useState(0);
  const [explorerScope, setExplorerScope] = useState<ExplorerScope>("reference");
  const [explorerError, setExplorerError] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const explorerCache = useRef(new Map<string, { moves: ExplorerMove[]; total: number }>());
  const explorerAbort = useRef<AbortController | null>(null);

  const engine = useEngine();
  const settings = useSettings();
  const skin = useBoardTheme();
  const autoAnalyse = settings.autoAnalyse;

  // The board is sized to the space it is given, so it fills the viewport
  // height on a desktop instead of sitting in a fixed-width box.
  const [stageRef, boardSize] = useSquareSize(BOARD_GUTTER);

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
    setReviewNotice(null);
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
    } catch (err) {
      if (err instanceof ApiError && err.code === "upgrade_required") {
        setReviewNotice(err.message);
      }
      setReviewing(false);
    }
  }, [gameId, reviewing]);

  /**
   * Do the server's annotations describe the move list we actually have?
   *
   * Annotations are keyed by ply index against a move list the browser
   * re-derives by parsing the PGN, while the server keyed them against its own
   * parse. If the two disagree by even one move, every badge, headline and
   * arrow after that point silently describes a different move — which is how
   * a review once announced "d4 is a blunder" directly above "Best was d4".
   *
   * ply_count comes from the server's parse, so comparing it to ours turns
   * that silent corruption into a visible, honest refusal.
   */
  const aligned =
    expectedPlies == null || history.length === 0 || history.length === expectedPlies;

  const annByPly = useMemo(() => {
    const m = new Map<number, Annotation>();
    if (!aligned) return m;
    for (const a of annotations) if (a.classification) m.set(a.ply, a);
    return m;
  }, [annotations, aligned]);

  const hasReview = annByPly.size > 0;

  // One replay of the game per move list, not one per cursor step. It yields
  // both the from/to squares (board highlighting + badges) and the position
  // after every ply, so moving the cursor is a lookup rather than a rebuild.
  const { moveSquares, fens } = useMemo(() => {
    const g = new Chess();
    const squares: { from: Square; to: Square }[] = [];
    const positions: string[] = [g.fen()]; // index 0 = start position
    for (const san of history) {
      try {
        const m = g.move(san);
        if (!m) break;
        squares.push({ from: m.from, to: m.to });
        positions.push(g.fen());
      } catch {
        break;
      }
    }
    return { moveSquares: squares, fens: positions };
  }, [history]);

  // The move the cursor just played (ply cursor-1) and its review verdict
  const reviewedMove = cursor > 0 ? moveSquares[cursor - 1] : undefined;
  const currentAnn = cursor > 0 ? annByPly.get(cursor - 1) : undefined;
  const reviewedClass = currentAnn?.classification;

  const highlightStyles = useMemo(() => {
    if (!reviewedMove || !settings.highlightLastMove) return {};
    return {
      [reviewedMove.from]: skin.lastMoveFrom,
      [reviewedMove.to]: skin.lastMoveTo,
    };
  }, [reviewedMove, settings.highlightLastMove, skin.lastMoveFrom, skin.lastMoveTo]);

  // Show the move the engine wanted instead, right on the board.
  const arrows = useMemo(() => {
    const uci = currentAnn?.best_uci;
    if (!settings.showBestArrow) return [];
    if (!uci || reviewedClass === "best" || reviewedClass === "book") return [];
    return [[uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, "#2FE3E8"] as const];
  }, [currentAnn, reviewedClass, settings.showBestArrow]);

  // Square -> top-left percentage within the board, respecting orientation.
  const squarePct = useCallback(
    (sq: string) => {
      const file = sq.charCodeAt(0) - 97; // a=0..h=7
      const rank = parseInt(sq[1], 10); // 1..8
      const col = orientation === "white" ? file : 7 - file;
      const row = orientation === "white" ? 8 - rank : rank - 1;
      return { left: col * 12.5, top: row * 12.5 };
    },
    [orientation]
  );

  // Load an initial PGN once on mount
  useEffect(() => {
    if (!initialPgn) return;
    const g = new Chess();
    try {
      g.loadPgn(initialPgn);
      setHistory(g.history());
      setCursor(0);
    } catch {
      /* malformed pgn - keep empty board */
    }
  }, [initialPgn]);

  // The position at the cursor, straight off the replay above.
  const fen = fens[Math.min(cursor, fens.length - 1)];

  // Ask the engine + explorer once the position stops changing. A cached
  // explorer answer is applied immediately, so revisiting a position you have
  // already seen never flickers or waits.
  useEffect(() => {
    const key = `${explorerScope}:${fen}`;
    const hit = explorerCache.current.get(key);
    if (hit) {
      setExplorer(hit.moves);
      setExplorerTotal(hit.total);
      setExplorerError(false);
    }

    const timer = setTimeout(() => {
      if (autoAnalyse && engine.connected) {
        engine.analyse(fen, settings.depth, settings.multipv);
      }
      if (hit) return;

      // Only the newest position's answer may land; an older in-flight reply
      // would otherwise overwrite the panel with the wrong position's book.
      explorerAbort.current?.abort();
      const ctrl = new AbortController();
      explorerAbort.current = ctrl;

      api
        .explorer(fen, explorerScope, ctrl.signal)
        .then((res) => {
          if (explorerCache.current.size >= EXPLORER_CACHE_MAX) {
            explorerCache.current.clear();
          }
          explorerCache.current.set(key, { moves: res.moves, total: res.total_games });
          setExplorer(res.moves);
          setExplorerTotal(res.total_games);
          setExplorerError(false);
        })
        .catch(() => {
          if (ctrl.signal.aborted) return; // superseded, not a failure
          setExplorer([]);
          setExplorerTotal(0);
          setExplorerError(true);
        });
    }, SETTLE_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, engine.connected, autoAnalyse, explorerScope, settings.depth, settings.multipv]);

  useEffect(() => () => explorerAbort.current?.abort(), []);

  // Playing a move from the current cursor truncates any future moves
  const onDrop = useCallback(
    (from: string, to: string) => {
      // Starting from the cursor's FEN is enough to validate and name the
      // move, and avoids replaying the game to get there.
      const g = new Chess(fen);
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
    [cursor, history, fen]
  );

  const { onSquareClick, squareStyles } = useClickToMove(fen, onDrop);

  const goStart = useCallback(() => setCursor(0), []);
  const goBack = useCallback(() => setCursor((c) => Math.max(0, c - 1)), []);
  const goNext = useCallback(
    () => setCursor((c) => Math.min(history.length, c + 1)),
    [history.length]
  );
  const goEnd = useCallback(() => setCursor(history.length), [history.length]);
  const flip = useCallback(
    () => setOrientation((o) => (o === "white" ? "black" : "white")),
    []
  );

  // Keyboard navigation, like every serious chess GUI
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === "ArrowLeft") goBack();
      if (e.key === "ArrowRight") goNext();
      if (e.key === "ArrowUp") goStart();
      if (e.key === "ArrowDown") goEnd();
      if (e.key === "f") flip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goBack, goNext, goStart, goEnd, flip]);

  const best = engine.lines[0];
  const evalText = formatEval(best);
  const whiteAdvantage = (best?.cp ?? 0) >= 0 && (best?.mate ?? 0) >= 0;

  // Eval bar height: clamp centipawns to a readable range
  const barPct = useMemo(() => {
    if (best?.mate != null) return best.mate > 0 ? 100 : 0;
    const cp = best?.cp ?? 0;
    return Math.max(2, Math.min(98, 50 + cp / 20));
  }, [best]);

  const badge = Math.max(16, Math.min(30, boardSize * 0.062));

  return (
    <div className="flex flex-col lg:h-full lg:flex-row">
      {/* ---------- Board stage: fills the workspace, top to bottom ---------- */}
      {/* Outer box owns the padding so the measured inner box is the content
          box - on a desktop there is none, and the board meets both edges. */}
      <div
        className="w-full aspect-square px-3 lg:aspect-auto lg:h-full lg:min-h-0
                   lg:w-auto lg:min-w-0 lg:flex-1 lg:px-0"
      >
        <div
          ref={stageRef}
          className="relative flex h-full w-full items-center justify-center gap-2"
        >
          {settings.showEvalBar && (
            <EvalBar
              pct={barPct}
              text={evalText}
              whiteAhead={whiteAdvantage}
              flipped={orientation === "black"}
              height={boardSize}
            />
          )}

          <div
            className="relative"
            style={{ width: boardSize || undefined, height: boardSize || undefined }}
          >
            {boardSize > 0 && (
              <Chessboard
                position={fen}
                boardWidth={boardSize}
                onPieceDrop={onDrop}
                onSquareClick={onSquareClick}
                boardOrientation={orientation}
                customArrows={arrows.map((a) => [...a] as [Square, Square, string])}
                customArrowColor="#2FE3E8"
                customNotationStyle={{ fontSize: "10px", fontWeight: "600" }}
                animationDuration={skin.animationMs}
                {...skin.props}
                customSquareStyles={{ ...highlightStyles, ...squareStyles }}
              />
            )}

            {/* Verdict badge on the destination square */}
            {settings.showVerdictBadge && reviewedMove && reviewedClass && (
              <div
                className="pointer-events-none absolute z-10 animate-pop"
                style={{
                  left: `${squarePct(reviewedMove.to).left + 12.5}%`,
                  top: `${squarePct(reviewedMove.to).top}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <span
                  className="flex items-center justify-center rounded-full font-bold text-white shadow-md ring-2 ring-black/25"
                  style={{
                    background: CLASS_META[reviewedClass].bg,
                    width: badge,
                    height: badge,
                    fontSize:
                      CLASS_META[reviewedClass].glyph.length > 1
                        ? badge * 0.45
                        : badge * 0.58,
                  }}
                >
                  {CLASS_META[reviewedClass].glyph}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---------- Analysis panel ---------- */}
      <aside
        className="flex w-full shrink-0 flex-col border-white/[0.07] bg-panel/60 backdrop-blur-xl
                   border-t lg:h-full lg:w-[352px] lg:border-l lg:border-t-0 xl:w-[400px]"
      >
        {/* Header: what you are looking at */}
        <div className="shrink-0 border-b border-white/[0.06] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="eyebrow">Game review</span>
            <span className="ml-auto font-mono text-[11px] text-muted">
              {cursor}/{history.length}
            </span>
          </div>
          <p className="mt-0.5 truncate text-sm font-medium" title={gameLabel}>
            {gameLabel ?? "Free analysis board"}
          </p>
        </div>

        {/* Tabs */}
        <div className="shrink-0 px-3 pt-2.5">
          <div className="seg w-full justify-between">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-pressed={tab === t.id}
                className={`seg-item flex-1 text-center text-xs ${
                  tab === t.id ? "seg-item-on" : ""
                }`}
              >
                {t.label}
                {t.id === "moves" && history.length > 0 && (
                  <span className="ml-1 text-[10px] opacity-60">{history.length}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Scrolling body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {!aligned && (
            <div className="mb-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed">
              This game&apos;s review was built from {expectedPlies} moves but the
              board reads {history.length}, so the two no longer line up. Hiding
              it rather than labelling the wrong moves — re-run the review to
              rebuild it.
            </div>
          )}

          {reviewNotice && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs">
              <span>⏳ {reviewNotice}</span>
              <Link href="/pricing" className="ml-auto shrink-0 text-gold underline">
                See plans
              </Link>
            </div>
          )}

          {tab === "review" && (
            <ReviewPanel
              history={history}
              annotations={aligned ? annotations : []}
              summary={reviewSummary}
              cursor={cursor}
              onSeek={setCursor}
              reviewing={reviewing}
              onRun={runReview}
              canRun={gameId != null}
            />
          )}
          {tab === "moves" && (
            <MoveList
              history={history}
              annByPly={annByPly}
              cursor={cursor}
              onSeek={setCursor}
            />
          )}
          {tab === "engine" && (
            <EnginePane
              lines={engine.lines}
              depth={engine.depth}
              connected={engine.connected}
              thinking={engine.thinking}
              error={engine.error}
              autoAnalyse={autoAnalyse}
              onToggleAuto={(autoAnalyse) => updateSettings({ autoAnalyse })}
            />
          )}
          {tab === "book" && (
            <ExplorerPane
              moves={explorer}
              total={explorerTotal}
              scope={explorerScope}
              onScope={setExplorerScope}
              error={explorerError}
              onPlay={(uci) => onDrop(uci.slice(0, 2), uci.slice(2, 4))}
            />
          )}
        </div>

        {/* Transport controls: pinned to the panel on a desktop, and stuck to
            the bottom of the viewport while scrolling on a phone. */}
        <div className="sticky bottom-0 shrink-0 border-t border-white/[0.06] bg-panel/90 p-2.5 backdrop-blur-xl lg:static lg:bg-transparent lg:backdrop-blur-none">
          {hasReview && cursor < history.length && (
            <button className="btn-go mb-2 w-full text-sm" onClick={goNext}>
              Next move  →
            </button>
          )}
          <div className="flex items-center gap-2">
            <div className="flex flex-1 divide-x divide-white/10 overflow-hidden rounded-lg border border-white/10 bg-white/[0.05]">
              {[
                { glyph: "«", title: "Start (↑)", go: goStart },
                { glyph: "‹", title: "Back (←)", go: goBack },
                { glyph: "›", title: "Forward (→)", go: goNext },
                { glyph: "»", title: "End (↓)", go: goEnd },
              ].map((b) => (
                <button
                  key={b.glyph}
                  onClick={b.go}
                  title={b.title}
                  aria-label={b.title}
                  className="flex-1 py-1.5 text-lg leading-none text-muted transition-colors hover:bg-white/10 hover:text-ink"
                >
                  {b.glyph}
                </button>
              ))}
            </div>
            <button
              onClick={flip}
              title="Flip board (f)"
              aria-label="Flip board"
              className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-lg leading-none text-muted transition-colors hover:bg-white/10 hover:text-ink"
            >
              ⟳
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
