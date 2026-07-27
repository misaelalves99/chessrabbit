"use client";

import { ReactNode } from "react";

interface Props {
  title: string;
  /** One line saying what the reader is looking at. */
  hint?: string;
  /** Display toggles ("Overall / By colour"), rendered top-right. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function ChartCard({
  title,
  hint,
  actions,
  children,
  className = "",
}: Props) {
  return (
    <section className={`card p-4 ${className}`}>
      <header className="mb-3 flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-semibold">{title}</h3>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/**
 * A single number that deserves to be read before any chart on the card.
 * Not every question needs a plot - "how many games?" is one of them.
 */
export function StatTile({
  value,
  label,
  sub,
  tone = "ink",
}: {
  value: string;
  label: string;
  sub?: string;
  tone?: "ink" | "accent" | "good" | "bad";
}) {
  const toneClass = {
    ink: "text-ink",
    accent: "text-accent",
    good: "text-good",
    bad: "text-bad",
  }[tone];

  return (
    <div className="card-tight px-3 py-2.5">
      <div className={`font-display text-2xl font-bold leading-none ${toneClass}`}>
        {value}
      </div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-muted">
        {label}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted/70">{sub}</div>}
    </div>
  );
}
