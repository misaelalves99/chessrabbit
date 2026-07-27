"use client";

import { useEffect, useRef } from "react";
import { Annotation } from "@/lib/api";
import { CLASS_META } from "@/lib/classification";

interface Props {
  history: string[];
  annByPly: Map<number, Annotation>;
  cursor: number;
  onSeek: (ply: number) => void;
}

/** Nearest ancestor that actually scrolls, or null if the page is the scroller. */
function scrollingParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/**
 * Paired move list: one row per full move, White then Black, each with its
 * review verdict. The row for the current ply is kept in view so stepping
 * through a long game never leaves you hunting for your place.
 */
export default function MoveList({ history, annByPly, cursor, onSeek }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Centre the current move inside the panel. Deliberately not
  // scrollIntoView: on a phone the panel does not scroll, and the browser
  // would drag the whole page - board and all - to chase the move.
  useEffect(() => {
    const el = activeRef.current;
    const box = scrollingParent(el);
    if (!el || !box) return;
    const e = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    box.scrollBy({
      top: e.top + e.height / 2 - (b.top + b.height / 2),
      behavior: "smooth",
    });
  }, [cursor]);

  if (history.length === 0) {
    return (
      <p className="text-xs text-muted px-1 py-3">
        Drag a piece — or click it — to start a line. Arrow keys walk the moves.
      </p>
    );
  }

  const rows = Math.ceil(history.length / 2);

  const cell = (ply: number) => {
    const san = history[ply];
    if (!san) return <span />;
    const meta = annByPly.get(ply)?.classification
      ? CLASS_META[annByPly.get(ply)!.classification!]
      : null;
    const active = cursor === ply + 1;
    return (
      <button
        ref={active ? activeRef : undefined}
        onClick={() => onSeek(ply + 1)}
        title={annByPly.get(ply)?.review ?? undefined}
        aria-current={active ? "true" : undefined}
        className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-[13px]
                    transition-colors ${
                      active
                        ? "bg-accent/25 text-ink font-semibold ring-1 ring-accent/50"
                        : "hover:bg-white/[0.07]"
                    }`}
      >
        {meta && (
          <span
            className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[8px] font-bold text-white"
            style={{ background: meta.bg }}
          >
            {meta.glyph}
          </span>
        )}
        <span className={meta && !active ? meta.color : undefined}>{san}</span>
      </button>
    );
  };

  return (
    <div className="grid grid-cols-[1.75rem_1fr_1fr] items-center gap-x-1 gap-y-0.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="contents">
          <span className="text-right pr-1 font-mono text-[11px] text-muted">
            {i + 1}.
          </span>
          {cell(i * 2)}
          {cell(i * 2 + 1)}
        </div>
      ))}
    </div>
  );
}
