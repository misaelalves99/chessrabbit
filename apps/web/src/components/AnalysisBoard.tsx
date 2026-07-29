"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useEngine, formatEval } from "@/hooks/useEngine";
import { useClickToMove } from "@/hooks/useClickToMove";
import { useMoveTree } from "@/hooks/useMoveTree";
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
 * The Clipboard API wants a secure context and a live user gesture, and
 * refuses outright in an iframe without permission - so the deprecated path
 * stays as a fallback, and the caller is told when both refuse rather than
 * being left to wonder why the button did nothing.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the old way */
  }
  try {
    const box = document.createElement("textarea");
    box.value = text;
    box.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(box);
    return ok;
  } catch {
    return false;
  }
}

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
  /** Ply count from the server's parse — the fallback alignment check. */
  expectedPlies?: number;
}

export default function AnalysisBoard({
  initialPgn,
  gameLabel,
  gameId,
  initialAnnotations,
  expectedPlies,
}: Props) {
  // The tree is the authoritative position: the game, plus every line tried
  // instead of it. Its main line is the game, which is what lets the review
  // below go on keying itself by ply.
  //
  // Lines are kept per game, so reopening one from the rail brings back what
  // you found in it. A pasted PGN with no game behind it has no stable name to
  // file them under, so it gets none; the empty board is its own scratch pad.
  const storageKey = gameId != null ? `game:${gameId}` : initialPgn ? undefined : "scratch";
  const mt = useMoveTree(initialPgn, storageKey);
  const { history, fen, cursorId, onMainline } = mt;

  const [copied, setCopied] = useState<"done" | "failed" | null>(null);

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
   * Keep only the annotations that provably describe the move we hold.
   *
   * Annotations are keyed by ply index against a move list the browser
   * re-derives by parsing the PGN, while the server keyed them against its own
   * parse. If the two disagree by even one move, every badge, headline and
   * arrow after that point silently describes a different move — which is how
   * a review once announced "d4 is a blunder" directly above "Best was d4".
   *
   * Each row now carries the move it reviews, so alignment is checked per ply
   * rather than assumed. Rows predating migration 011 have no move recorded;
   * for those we fall back to comparing the whole-game ply count, which catches
   * a diverged parse without being able to pinpoint it.
   *
   * The check runs against the tree's main line, never against a variation:
   * the main line is the game the server reviewed, and a line you invented
   * has no review to be aligned with in the first place.
   */
  const { annByPly, mismatched } = useMemo(() => {
    const m = new Map<number, Annotation>();
    let bad = 0;

    // Only meaningful once the PGN has been read into the main line.
    const countAgrees =
      expectedPlies == null || history.length === 0 || history.length === expectedPlies;

    for (const a of annotations) {
      if (!a.classification) continue;
      const played = mt.mainUci[a.ply];

      if (a.move_uci) {
        // No move at this ply means the row describes a game we do not have.
        // from+to is enough: a promotion suffix cannot change which move it is.
        if (!played || a.move_uci.slice(0, 4) !== played.slice(0, 4)) {
          bad++;
          continue;
        }
      } else if (!countAgrees) {
        bad++;
        continue;
      }
      m.set(a.ply, a);
    }
    return { annByPly: m, mismatched: bad };
  }, [annotations, mt.mainUci, expectedPlies, history.length]);

  const hasReview = annByPly.size > 0;

  /** Moves that exist only because you went looking - the root is not one. */
  const exploredMoves = mt.tree.nodes.size - 1 - history.length;

  // The move that led here is highlighted wherever it was played; only a move
  // of the game itself carries a verdict.
  const reviewedMove = mt.lastMove;
  const currentAnn = onMainline && mt.cursorPly > 0 ? annByPly.get(mt.node.ply) : undefined;
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

  // Playing a move branches off the position you are standing on. Nothing is
  // ever thrown away to make room for it.
  const onDrop = mt.play;

  const { onSquareClick, squareStyles } = useClickToMove(fen, onDrop);

  const flip = useCallback(
    () => setOrientation((o) => (o === "white" ? "black" : "white")),
    []
  );

  // PGN writes variations natively, so the lines you found leave here in a
  // form ChessBase, Lichess and SCID all already understand.
  const copyPgn = useCallback(async () => {
    setCopied((await copyText(mt.exportPgn())) ? "done" : "failed");
    setTimeout(() => setCopied(null), 1800);
  }, [mt]);

  // Keyboard navigation, like every serious chess GUI. Alt+Up/Down cycling the
  // alternatives at a point is the one that makes a tree walkable; Escape is
  // the way out once you are four moves deep in a line that never happened.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === "ArrowLeft") mt.back();
      if (e.key === "ArrowRight") mt.next();
      if (e.key === "ArrowUp") (e.altKey ? mt.nextAlternative(-1) : mt.toStart());
      if (e.key === "ArrowDown") (e.altKey ? mt.nextAlternative(1) : mt.toEnd());
      if (e.key === "Escape") mt.backToGame();
      if (e.key === "Delete" || e.key === "Backspace") mt.removeLine();
      if (e.key === "f") flip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mt, flip]);

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
              {onMainline ? mt.cursorPly : "–"}/{history.length}
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
          {mismatched > 0 && (
            <div className="mb-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed">
              {mismatched} reviewed move{mismatched === 1 ? "" : "s"} in this game
              no longer match the board, so {mismatched === 1 ? "it is" : "they are"}{" "}
              hidden rather than labelled against the wrong move. Re-run the
              review to rebuild it.
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

          {/* Off the game, there is no review to show and the coach says
              nothing - so say where you are instead, and offer the way back. */}
          {!onMainline && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
              <span>You&rsquo;re in a line that wasn&rsquo;t played.</span>
              <button
                onClick={mt.backToGame}
                className="ml-auto shrink-0 text-accent underline"
              >
                Back to the game
              </button>
            </div>
          )}

          {tab === "review" && (
            <ReviewPanel
              history={history}
              annotations={[...annByPly.values()]}
              summary={reviewSummary}
              cursor={mt.cursorPly}
              onSeek={mt.seekPly}
              reviewing={reviewing}
              onRun={runReview}
              canRun={gameId != null}
              onShowBest={(san) => {
                mt.playInstead([san]);
                setTab("moves");
              }}
            />
          )}
          {tab === "moves" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="truncate">
                  {exploredMoves > 0
                    ? `${exploredMoves} move${exploredMoves === 1 ? "" : "s"} in lines you tried`
                    : "Play a move anywhere to start a line"}
                </span>
                <button
                  onClick={copyPgn}
                  disabled={history.length === 0}
                  className={`ml-auto shrink-0 rounded border px-2 py-0.5 transition-colors
                             disabled:opacity-40 disabled:hover:bg-transparent ${
                               copied === "failed"
                                 ? "border-bad/40 text-bad"
                                 : "border-white/10 hover:bg-white/10 hover:text-ink"
                             }`}
                >
                  {copied === "done"
                    ? "Copied"
                    : copied === "failed"
                      ? "Copy blocked"
                      : "Copy PGN"}
                </button>
              </div>
              <MoveList
                tree={mt.tree}
                rows={mt.rows}
                annByPly={annByPly}
                cursorId={cursorId}
                onSeek={mt.seek}
              />
            </div>
          )}
          {tab === "engine" && (
            <EnginePane
              lines={engine.lines}
              fen={fen}
              depth={engine.depth}
              connected={engine.connected}
              thinking={engine.thinking}
              error={engine.error}
              autoAnalyse={autoAnalyse}
              onToggleAuto={(autoAnalyse) => updateSettings({ autoAnalyse })}
              onPlayLine={(sans, evalCp) => mt.playLine(sans, { evalCp })}
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
          {hasReview && onMainline && mt.node.children.length > 0 && (
            <button className="btn-go mb-2 w-full text-sm" onClick={mt.next}>
              Next move  →
            </button>
          )}
          {mt.alternatives.length > 1 && (
            <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
              <span className="shrink-0">
                {mt.alternatives.indexOf(cursorId) + 1} of {mt.alternatives.length} tried here
              </span>
              <button
                onClick={() => mt.nextAlternative(-1)}
                title="Previous alternative (Alt+↑)"
                className="ml-auto rounded border border-white/10 px-1.5 py-0.5 hover:bg-white/10 hover:text-ink"
              >
                ↑
              </button>
              <button
                onClick={() => mt.nextAlternative(1)}
                title="Next alternative (Alt+↓)"
                className="rounded border border-white/10 px-1.5 py-0.5 hover:bg-white/10 hover:text-ink"
              >
                ↓
              </button>
              {!onMainline && (
                <button
                  onClick={mt.removeLine}
                  title="Delete this line (Del)"
                  className="rounded border border-white/10 px-1.5 py-0.5 hover:bg-bad/20 hover:text-bad"
                >
                  ✕
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="flex flex-1 divide-x divide-white/10 overflow-hidden rounded-lg border border-white/10 bg-white/[0.05]">
              {[
                { glyph: "«", title: "Start (↑)", go: mt.toStart },
                { glyph: "‹", title: "Back (←)", go: mt.back },
                { glyph: "›", title: "Forward (→)", go: mt.next },
                { glyph: "»", title: "End (↓)", go: mt.toEnd },
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
