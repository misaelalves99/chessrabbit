"use client";

import { SEQUENTIAL } from "@/lib/vizTheme";

export interface Column {
  key: string;
  label: string;
  value: number | null;
  /** Secondary line under the axis label, e.g. a sample size. */
  sub?: string;
  color?: string;
}

interface Props {
  columns: Column[];
  /** Axis top. Accuracy is a percentage, so it defaults to 100. */
  max?: number;
  unit?: string;
  height?: number;
  /** Rendered where a column has no value at all. */
  emptyNote?: string;
}

/**
 * One measure across a handful of categories, drawn as columns.
 *
 * Built from divs rather than SVG so the value labels stay crisp at any width
 * and never distort with the plot. Every column is directly labelled, which is
 * also what lets a single hue carry the whole chart.
 */
export default function Columns({
  columns,
  max = 100,
  unit = "",
  height = 148,
  emptyNote = "Not enough reviewed games",
}: Props) {
  const present = columns.filter((c) => c.value !== null);
  if (present.length === 0) {
    return <p className="py-6 text-center text-xs text-muted">{emptyNote}</p>;
  }

  return (
    <div>
      <div
        className="flex items-end gap-2 border-b border-white/[0.07]"
        style={{ height }}
      >
        {columns.map((c) => {
          const value = c.value ?? 0;
          const share = Math.max(0, Math.min(100, (value / max) * 100));
          return (
            <div
              key={c.key}
              className="group relative flex h-full flex-1 flex-col justify-end"
              title={c.value === null ? "No data" : `${c.label}: ${value}${unit}`}
            >
              {c.value !== null && (
                <>
                  <span className="mb-1 text-center font-mono text-[11px] font-semibold text-ink">
                    {value}
                    {unit}
                  </span>
                  <div
                    className="w-full rounded-t-[4px] transition-[height] duration-500 ease-out"
                    style={{
                      height: `${share}%`,
                      background: c.color ?? SEQUENTIAL[2],
                    }}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-2 pt-1.5">
        {columns.map((c) => (
          <div key={c.key} className="min-w-0 flex-1 text-center">
            <div className="truncate text-[11px] text-muted">{c.label}</div>
            {c.sub && (
              <div className="truncate font-mono text-[10px] text-muted/70">{c.sub}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
