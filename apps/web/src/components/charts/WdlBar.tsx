"use client";

import { OUTCOME, shares } from "@/lib/vizTheme";

interface Props {
  wins: number;
  draws: number;
  losses: number;
  /** Show the percentage above the bar. Off for dense table rows. */
  labels?: boolean;
  height?: number;
}

/**
 * Win / draw / loss as one stacked bar.
 *
 * Segments are always in win → draw → loss order and always carry a label, so
 * the reading never depends on telling green from red. A 2px surface gap keeps
 * adjacent segments from bleeding into one another.
 */
export default function WdlBar({
  wins,
  draws,
  losses,
  labels = true,
  height = 8,
}: Props) {
  const total = wins + draws + losses;
  const [w, d, l] = shares([wins, draws, losses]);
  const segments = [
    { key: "win", value: wins, share: w, color: OUTCOME.win, label: "Won" },
    { key: "draw", value: draws, share: d, color: OUTCOME.draw, label: "Drawn" },
    { key: "loss", value: losses, share: l, color: OUTCOME.loss, label: "Lost" },
  ];

  if (total === 0) {
    return <div className="text-xs text-muted">No games</div>;
  }

  return (
    <div className="w-full">
      {labels && (
        <div className="mb-1 flex items-baseline gap-3 text-xs">
          {segments.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: s.color }}
              />
              <span className="font-mono font-semibold text-ink">
                {s.share.toFixed(1)}%
              </span>
              <span className="text-muted">{s.label}</span>
            </span>
          ))}
        </div>
      )}
      <div
        className="flex w-full overflow-hidden rounded-full"
        style={{ height }}
        role="img"
        aria-label={`${wins} won, ${draws} drawn, ${losses} lost of ${total} games`}
      >
        {segments.map((s, i) =>
          s.share === 0 ? null : (
            <div
              key={s.key}
              title={`${s.label}: ${s.value.toLocaleString()} (${s.share.toFixed(1)}%)`}
              style={{
                width: `${s.share}%`,
                background: s.color,
                // 2px of surface between segments, never before the first.
                marginLeft: i === 0 ? 0 : 2,
              }}
            />
          )
        )}
      </div>
    </div>
  );
}
