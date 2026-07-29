"use client";

/**
 * Game Review: the coach's verdict on the move you are looking at, an accuracy
 * summary, a clickable evaluation curve, and per-side verdict counts.
 * Everything here comes from the server's engine review - no client analysis.
 */

import { useMemo, useRef } from "react";
import { Chess } from "chess.js";
import { Annotation, Classification, ReviewSummary } from "@/lib/api";
import { CLASS_META, CLASS_ORDER, headline } from "@/lib/classification";

const DOT_FILL: Partial<Record<Classification, string>> = {
  inaccuracy: "#FFC53D",
  mistake: "#FF9F3D",
  blunder: "#FF5F63",
};

/** Same logistic centipawn -> win% mapping the server uses. */
function winPct(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function evalText(cp: number | null): string {
  if (cp == null) return "";
  if (cp >= 9000) return "+M";
  if (cp <= -9000) return "-M";
  const p = cp / 100;
  return (p >= 0 ? "+" : "") + p.toFixed(1);
}

interface Props {
  history: string[];
  annotations: Annotation[];
  summary: ReviewSummary | null;
  cursor: number;
  onSeek: (ply: number) => void;
  reviewing: boolean;
  onRun: () => void;
  canRun: boolean;
  /** Put the engine's preference on the board, beside the move that was played. */
  onShowBest?: (san: string) => void;
}

export default function ReviewPanel({
  history,
  annotations,
  summary,
  cursor,
  onSeek,
  reviewing,
  onRun,
  canRun,
  onShowBest,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const byPly = useMemo(() => {
    const m = new Map<number, Annotation>();
    for (const a of annotations) if (a.classification) m.set(a.ply, a);
    return m;
  }, [annotations]);

  const hasReview = byPly.size > 0;
  const N = history.length;

  // Counts survive a reload even without the job result: derive from annotations.
  const counts = useMemo(() => {
    if (summary) return summary.classifications;
    const out: ReviewSummary["classifications"] = { white: {}, black: {} };
    for (const a of byPly.values()) {
      if (!a.classification) continue;
      const side = a.ply % 2 === 0 ? "white" : "black";
      out[side][a.classification] = (out[side][a.classification] ?? 0) + 1;
    }
    return out;
  }, [summary, byPly]);

  // Eval curve: x scaled into a fixed 300x80 viewBox, y = White's win share.
  const W = 300;
  const H = 80;
  const graph = useMemo(() => {
    if (!hasReview || N === 0) return null;
    const pts: [number, number][] = [[0, H / 2]];
    for (let i = 0; i < N; i++) {
      const a = byPly.get(i);
      if (!a || a.eval_cp == null) continue;
      const x = ((i + 1) / N) * W;
      const y = H * (1 - winPct(a.eval_cp) / 100);
      pts.push([x, y]);
    }
    const path =
      `M0,${H} L` +
      pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L") +
      ` L${W},${pts[pts.length - 1][1].toFixed(1)} L${W},${H} Z`;
    const dots = [...byPly.values()]
      .filter((a) => a.classification && DOT_FILL[a.classification])
      .map((a) => ({
        x: ((a.ply + 1) / N) * W,
        y: H * (1 - winPct(a.eval_cp ?? 0) / 100),
        fill: DOT_FILL[a.classification!]!,
        ply: a.ply,
      }));
    return { path, dots };
  }, [hasReview, N, byPly]);

  const seekFromPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || N === 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(N, Math.round(frac * N))));
  };

  // The move the cursor just played (annotation of ply cursor-1)
  const current = cursor > 0 ? byPly.get(cursor - 1) : undefined;
  const currentMeta = current?.classification
    ? CLASS_META[current.classification]
    : null;

  // Best-move SAN for the why box, derived client-side with chess.js
  const bestSan = useMemo(() => {
    if (!current?.best_uci || cursor === 0) return null;
    try {
      const g = new Chess();
      for (let i = 0; i < cursor - 1; i++) g.move(history[i]);
      const mv = g.move({
        from: current.best_uci.slice(0, 2),
        to: current.best_uci.slice(2, 4),
        promotion: current.best_uci[4] ?? "q",
      });
      return mv?.san ?? null;
    } catch {
      return null;
    }
  }, [current, cursor, history]);

  return (
    <div className="space-y-3">
      {/* ---------- Coach callout ---------- */}
      <div className="flex items-start gap-2.5">
        <div
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl
                     bg-gradient-to-br from-accent/30 to-accent2/20 ring-1 ring-white/10"
          aria-hidden
        >
          🐰
        </div>

        {current && currentMeta ? (
          <div
            key={cursor}
            className="relative flex-1 animate-rise rounded-2xl rounded-tl-sm bg-panelAlt/90 p-3
                       ring-1 ring-white/[0.08] shadow-card"
            style={{ borderLeft: `3px solid ${currentMeta.bg}` }}
          >
            <div className="flex items-center gap-2">
              <span
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full font-bold text-white animate-pop"
                style={{
                  background: currentMeta.bg,
                  fontSize: currentMeta.glyph.length > 1 ? 11 : 14,
                }}
              >
                {currentMeta.glyph}
              </span>
              <span className="text-sm font-semibold leading-tight">
                {/* The server's SAN wins: it comes from the same parse the
                    review was written against, so the headline can never
                    disagree with the sentence underneath it. */}
                {headline(
                  current.move_san ?? history[cursor - 1] ?? "",
                  current.classification!
                )}
              </span>
              <span className="ml-auto shrink-0 rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-xs">
                {evalText(current.eval_cp)}
              </span>
            </div>

            {current.review && (
              <p className="mt-2 text-xs leading-relaxed text-ink/75">{current.review}</p>
            )}
            {/* Telling you what you should have played and giving you no way
                to see it was only ever a limitation of a move list that had to
                delete the game to show you. It doesn't any more. */}
            {bestSan &&
              current.classification !== "best" &&
              current.classification !== "book" &&
              (onShowBest ? (
                <button
                  onClick={() => onShowBest(bestSan)}
                  className="mt-1.5 flex items-center gap-1.5 rounded-md border border-accent/30
                             bg-accent/10 px-2 py-1 text-xs text-accent transition-colors
                             hover:bg-accent/20"
                >
                  Best was <span className="font-mono font-semibold">{bestSan}</span>
                  <span className="text-accent/70">— show me</span>
                </button>
              ) : (
                <p className="mt-1.5 text-xs text-accent">
                  Best was <span className="font-mono font-semibold">{bestSan}</span>
                </p>
              ))}
          </div>
        ) : (
          <div className="flex-1 rounded-2xl rounded-tl-sm bg-panelAlt/70 p-3 ring-1 ring-white/[0.06]">
            <p className="text-sm font-semibold">
              {reviewing
                ? "Going through every move…"
                : hasReview
                  ? "Step through the game"
                  : canRun
                    ? "Ready when you are"
                    : "Open a game to review it"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {reviewing
                ? "The engine is scoring both sides. This takes a few seconds."
                : hasReview
                  ? "Pick a move and I'll tell you what happened."
                  : canRun
                    ? "I'll classify every move, score both sides, and show you what you missed."
                    : "Pick one of your games from the rail — or import a PGN — and I'll review it."}
            </p>
          </div>
        )}
      </div>

      {canRun && (
        <button
          className={`w-full text-sm ${hasReview ? "btn" : "btn-primary"}`}
          onClick={onRun}
          disabled={reviewing}
        >
          {reviewing ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-white" />
              Reviewing…
            </span>
          ) : hasReview ? (
            "Re-run review"
          ) : (
            "▶  Review this game"
          )}
        </button>
      )}

      {/* ---------- Accuracy ---------- */}
      {summary && hasReview && (
        <div className="grid grid-cols-2 gap-2">
          {(["white", "black"] as const).map((side) => (
            <div
              key={side}
              className="card-tight flex items-center gap-2 px-2.5 py-2"
            >
              <span
                className={`h-3.5 w-3.5 shrink-0 rounded-[3px] ring-1 ring-white/30 ${
                  side === "white" ? "bg-white" : "bg-[#0B1020]"
                }`}
              />
              <div className="min-w-0">
                <div className="font-display text-lg font-bold leading-none">
                  {summary.accuracy[side].toFixed(1)}
                  <span className="text-xs text-muted">%</span>
                </div>
                <div className="text-[10px] uppercase tracking-wider text-muted">
                  {side} accuracy
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- Eval curve ---------- */}
      {graph && (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-20 w-full cursor-crosshair rounded-xl bg-[#0B1020] ring-1 ring-white/[0.06]"
          onPointerDown={seekFromPointer}
          onPointerMove={(e) => e.buttons === 1 && seekFromPointer(e)}
          role="img"
          aria-label="Evaluation over the course of the game — click to jump to a move"
        >
          <defs>
            <linearGradient id="evalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#B9C2E6" stopOpacity="0.75" />
            </linearGradient>
          </defs>
          <path d={graph.path} fill="url(#evalFill)" />
          <line
            x1={0}
            y1={H / 2}
            x2={W}
            y2={H / 2}
            stroke="#8B7CFF"
            strokeWidth={0.6}
            strokeDasharray="3 3"
            opacity={0.7}
          />
          {graph.dots.map((d) => (
            <circle
              key={d.ply}
              cx={d.x}
              cy={d.y}
              r={3}
              fill={d.fill}
              stroke="#0B1020"
              strokeWidth={1}
            />
          ))}
          {cursor > 0 && (
            <line
              x1={(cursor / N) * W}
              y1={0}
              x2={(cursor / N) * W}
              y2={H}
              stroke="#2FE3E8"
              strokeWidth={1.5}
            />
          )}
        </svg>
      )}

      {/* ---------- Verdict counts ---------- */}
      {hasReview && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted">
              <th className="pb-1 text-left font-normal">Move quality</th>
              <th className="w-12 pb-1 text-right font-normal">White</th>
              <th className="w-12 pb-1 text-right font-normal">Black</th>
            </tr>
          </thead>
          <tbody>
            {CLASS_ORDER.map((cls) => {
              const w = counts.white[cls] ?? 0;
              const b = counts.black[cls] ?? 0;
              if (w === 0 && b === 0) return null;
              const meta = CLASS_META[cls];
              return (
                <tr key={cls} className="hover:bg-white/[0.04]">
                  <td className="py-0.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="grid h-4 w-4 place-items-center rounded-full text-[8px] font-bold text-white"
                        style={{ background: meta.bg }}
                      >
                        {meta.glyph}
                      </span>
                      <span className={meta.color}>{meta.label}</span>
                    </span>
                  </td>
                  <td className="text-right font-mono">{w}</td>
                  <td className="text-right font-mono">{b}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
