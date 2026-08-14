"use client";

import Link from "next/link";
import type { ExplorerMove, ExplorerScope } from "@/lib/api";

const SCOPES: { id: ExplorerScope; label: string; title?: string }[] = [
  { id: "reference", label: "Masters" },
  { id: "lichess_live", label: "Live", title: "Live from Lichess's Opening Explorer API" },
  { id: "mine", label: "My games" },
];

interface Props {
  moves: ExplorerMove[];
  total: number;
  scope: ExplorerScope;
  onScope: (s: ExplorerScope) => void;
  error: boolean;
  onPlay: (uci: string) => void;
  /** The position on the board, so it can be looked up in the database. */
  fen: string;
}

function emptyText(scope: ExplorerScope, error: boolean): string {
  if (error && scope === "lichess_live")
    return "Live Lichess explorer is unavailable right now — try again shortly.";
  if (scope === "mine") return "None of your games reached this position yet.";
  if (scope === "lichess_live")
    return "No master games have reached this position on Lichess.";
  return "No reference games for this position.";
}

/** Opening book: what strong players actually play from here, and how it goes. */
export default function ExplorerPane({
  moves,
  total,
  scope,
  onScope,
  error,
  onPlay,
  fen,
}: Props) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="seg">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              title={s.title}
              onClick={() => onScope(s.id)}
              className={`seg-item text-xs ${scope === s.id ? "seg-item-on" : ""}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[11px] text-muted">
          {total.toLocaleString()} games
        </span>
      </div>

      {moves.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted">{emptyText(scope, error)}</p>
      ) : (
        <ul className="space-y-0.5">
          {moves.slice(0, 10).map((m) => (
            <li key={m.uci}>
              <button
                onClick={() => onPlay(m.uci)}
                title={`Play ${m.san}`}
                className="grid w-full grid-cols-[3rem_3.5rem_1fr] items-center gap-2
                           rounded-md px-1.5 py-1 text-left transition-colors hover:bg-ivory/[0.08]"
              >
                <span className="font-mono text-[13px] font-semibold">{m.san}</span>
                <span className="text-right font-mono text-[11px] text-muted">
                  {m.games.toLocaleString()}
                </span>
                {/* Ivory / taupe / ebony, matching the piece swatches - this
                    bar is a result split, not a win-draw-loss for one player,
                    so it is coloured by side rather than by outcome. */}
                <span className="flex h-3.5 overflow-hidden rounded-sm ring-1 ring-black/40">
                  <span
                    style={{ width: `${m.white_pct}%` }}
                    className="bg-ivory"
                    title={`White ${m.white_pct}%`}
                  />
                  <span
                    style={{ width: `${m.draw_pct}%` }}
                    className="bg-[#8A8072]"
                    title={`Draw ${m.draw_pct}%`}
                  />
                  <span
                    style={{ width: `${m.black_pct}%` }}
                    className="bg-ebony"
                    title={`Black ${m.black_pct}%`}
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The book says which moves were played from here. This asks the other
          half of the question — who was here, and what happened to them. It is
          the point of indexing a zobrist per ply, and without a way in from the
          board it was a feature nobody could reach. */}
      <Link
        href={`/search/?fen=${encodeURIComponent(fen)}`}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-ivory/10
                   px-2 py-1.5 text-[11px] text-muted transition-colors
                   hover:bg-ivory/10 hover:text-ink"
      >
        Find games with this position
      </Link>
    </div>
  );
}
