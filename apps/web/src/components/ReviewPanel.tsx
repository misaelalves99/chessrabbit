"use client";

/**
 * Game Review panel: accuracy summary, per-move classification counts,
 * evaluation graph (click to seek), and a "why" box for the current move.
 * All content comes from the server's engine review - no client analysis.
 */

import { useMemo, useRef } from "react";
import { Chess } from "chess.js";
import { Annotation, Classification, ReviewSummary } from "@/lib/api";

export const CLASS_META: Record<
  Classification,
  { glyph: string; color: string; label: string; bg: string }
> = {
  book: { glyph: "📖", color: "text-[#c8a878]", label: "Book", bg: "#a3865f" },
  best: { glyph: "★", color: "text-accent", label: "Best", bg: "#7FA650" },
  excellent: { glyph: "✓", color: "text-green-300", label: "Excellent", bg: "#81b64c" },
  good: { glyph: "✓", color: "text-green-200", label: "Good", bg: "#7a9b57" },
  inaccuracy: { glyph: "?!", color: "text-yellow-300", label: "Inaccuracy", bg: "#e0a63c" },
  mistake: { glyph: "?", color: "text-orange-400", label: "Mistake", bg: "#e07a3c" },
  blunder: { glyph: "??", color: "text-red-400", label: "Blunder", bg: "#d9534f" },
};

/** Chess.com-style headline: name the move and its verdict. */
function headline(san: string, cls: Classification): string {
  switch (cls) {
    case "book":
      return `${san} is a book move`;
    case "best":
      return `${san} is the best move`;
    case "excellent":
      return `${san} is excellent`;
    case "good":
      return `${san} is a good move`;
    case "inaccuracy":
      return `${san} is an inaccuracy`;
    case "mistake":
      return `${san} is a mistake`;
    case "blunder":
      return `${san} is a blunder`;
  }
}

const DOT_FILL: Partial<Record<Classification, string>> = {
  inaccuracy: "#fde047",
  mistake: "#fb923c",
  blunder: "#f87171",
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

  const countRows: Classification[] = [
    "best",
    "excellent",
    "good",
    "book",
    "inaccuracy",
    "mistake",
    "blunder",
  ];

  return (
    <section className="bg-panelAlt rounded p-3">
      <header className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-sm">Game review</h3>
        {canRun && (
          <button className="btn text-xs" onClick={onRun} disabled={reviewing}>
            {reviewing ? "Reviewing…" : hasReview ? "Re-run review" : "▶ Review game"}
          </button>
        )}
      </header>

      {!hasReview && !reviewing && (
        <p className="text-xs text-muted">
          {canRun
            ? "Run a full review: every move classified and explained, with accuracy scores."
            : "Open one of your games to run a full review."}
        </p>
      )}
      {reviewing && (
        <p className="text-xs text-muted animate-pulse">
          The engine is going through every move…
        </p>
      )}

      {summary && hasReview && (
        <div className="flex gap-4 mb-2 text-sm">
          {(["white", "black"] as const).map((side) => (
            <div key={side} className="flex items-center gap-2">
              <span
                className={`w-3 h-3 rounded-sm border border-white/30 ${
                  side === "white" ? "bg-white" : "bg-black"
                }`}
              />
              <span className="text-muted text-xs">{side}</span>
              <span className="font-mono font-semibold">
                {summary.accuracy[side].toFixed(1)}%
              </span>
            </div>
          ))}
          <span className="text-xs text-muted self-center">accuracy</span>
        </div>
      )}

      {graph && (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-20 rounded cursor-crosshair bg-black/40 mb-2"
          onPointerDown={seekFromPointer}
          onPointerMove={(e) => e.buttons === 1 && seekFromPointer(e)}
        >
          <path d={graph.path} fill="#E8E6E3" opacity={0.9} />
          <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#9B9894" strokeWidth={0.5} strokeDasharray="2 3" />
          {graph.dots.map((d) => (
            <circle key={d.ply} cx={d.x} cy={d.y} r={3} fill={d.fill} stroke="#262421" strokeWidth={1} />
          ))}
          {cursor > 0 && (
            <line
              x1={(cursor / N) * W}
              y1={0}
              x2={(cursor / N) * W}
              y2={H}
              stroke="#7FA650"
              strokeWidth={1.5}
            />
          )}
        </svg>
      )}

      {current && currentMeta && (
        <div
          className="rounded-lg p-3 mb-2 bg-black/30"
          style={{ borderLeft: `4px solid ${currentMeta.bg}` }}
        >
          {/* Coach callout: badge + move name + eval */}
          <div className="flex items-center gap-2">
            <span
              className="flex items-center justify-center rounded-full text-white shrink-0"
              style={{
                background: currentMeta.bg,
                width: 24,
                height: 24,
                fontSize: currentMeta.glyph.length > 1 ? 11 : 14,
                lineHeight: 1,
              }}
            >
              {currentMeta.glyph}
            </span>
            <span className="font-semibold text-sm">
              {headline(history[cursor - 1] ?? "", current.classification!)}
            </span>
            <span className="font-mono text-xs ml-auto">
              {evalText(current.eval_cp)}
            </span>
          </div>

          <p className="text-xs text-ink/80 mt-2">{current.review}</p>
          {bestSan &&
            current.classification !== "best" &&
            current.classification !== "book" && (
              <p className="text-accent text-xs mt-1">Best was {bestSan}</p>
            )}

          <div className="flex items-center gap-2 mt-2">
            <button
              className="btn text-xs"
              onClick={() => onSeek(Math.max(0, cursor - 1))}
              disabled={cursor <= 1}
            >
              ◀ Prev
            </button>
            <button
              className="btn-primary text-xs flex-1"
              onClick={() => onSeek(Math.min(N, cursor + 1))}
              disabled={cursor >= N}
            >
              Next ▶
            </button>
          </div>
        </div>
      )}

      {hasReview && (
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="text-left font-normal">Move quality</th>
              <th className="text-right font-normal w-14">White</th>
              <th className="text-right font-normal w-14">Black</th>
            </tr>
          </thead>
          <tbody>
            {countRows.map((cls) => {
              const w = counts.white[cls] ?? 0;
              const b = counts.black[cls] ?? 0;
              if (w === 0 && b === 0) return null;
              const meta = CLASS_META[cls];
              return (
                <tr key={cls}>
                  <td className={`py-0.5 ${meta.color || "text-ink"}`}>
                    {meta.glyph && `${meta.glyph} `}
                    {meta.label}
                  </td>
                  <td className="text-right font-mono">{w}</td>
                  <td className="text-right font-mono">{b}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
