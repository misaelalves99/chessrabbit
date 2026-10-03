import type { Insights, OpeningRow } from "@/lib/api";

/**
 * The two or three things a player should actually do something about, pulled
 * out of the same data the charts are drawn from.
 *
 * Insights opened with a menu of six chart categories, which quietly made the
 * reader do the diagnosis: scan Openings, scan Moves, scan Phases, and work out
 * for yourself which number is the bad one. The charts are still all there —
 * this just reads them first and says what it found.
 *
 * Two rules keep it honest:
 *
 *   NEVER CLAIM A FINDING FROM A HANDFUL OF GAMES. Every threshold below is a
 *   minimum sample, not a nicety: "you score 0% in the Dutch" off two games is
 *   noise presented as advice.
 *
 *   NEVER CLAIM WHAT THE DATA CANNOT SUPPORT. Another player's games carry no
 *   engine annotations (`engine_metrics === false`), so accuracy and move
 *   quality are absent rather than zero, and the findings that rest on them are
 *   skipped entirely rather than rendered as 0%.
 */

export interface Finding {
  /** Short label — what kind of problem this is. */
  kind: string;
  /** The finding itself, as a phrase. */
  headline: string;
  /** The evidence, in the user's own numbers. */
  detail: string;
  /** Section to jump to for the chart this came from. */
  section: "games" | "results" | "phases" | "openings" | "moves" | "calendar";
  /** Worse than typical, or better — drives the accent. */
  tone: "bad" | "good";
}

/** Games needed before an opening's score means anything. */
const MIN_OPENING_GAMES = 6;
/** Games needed before a time-of-day or phase split means anything. */
const MIN_SPLIT_GAMES = 20;
/** Moves needed before a move-number accuracy dip means anything. */
const MIN_MOVES = 30;

function scoreOf(r: { wins: number; draws: number; games: number }): number {
  return r.games > 0 ? (r.wins + r.draws / 2) / r.games : 0;
}

function pctText(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** The opening, either colour, that is costing the most. */
function worstOpening(data: Insights): Finding | null {
  const rows: { row: OpeningRow; color: "White" | "Black" }[] = [
    ...data.openings.white.map((row) => ({ row, color: "White" as const })),
    ...data.openings.black.map((row) => ({ row, color: "Black" as const })),
  ].filter(({ row }) => row.games >= MIN_OPENING_GAMES);

  if (rows.length < 2) return null;

  const worst = rows.reduce((a, b) => (scoreOf(a.row) <= scoreOf(b.row) ? a : b));
  const overall = scoreOf({
    wins: data.overview.wins,
    draws: data.overview.draws,
    games: data.overview.played,
  });

  // Only worth saying if it is meaningfully below the player's own baseline.
  if (scoreOf(worst.row) >= overall - 0.08) return null;

  return {
    kind: "Weakest line",
    headline: `${worst.row.name} as ${worst.color}`,
    detail: `${pctText(scoreOf(worst.row))} score from ${worst.row.games} games, against ${pctText(overall)} overall.`,
    section: "openings",
    tone: "bad",
  };
}

/** The ten-move window where accuracy falls off. */
function accuracyDip(data: Insights): Finding | null {
  if (data.engine_metrics === false) return null;
  const rows = data.overview.accuracy_by_move.filter(
    (r) => r.accuracy != null && r.moves >= MIN_MOVES
  );
  if (rows.length < 3) return null;

  const worst = rows.reduce((a, b) => (a.accuracy! <= b.accuracy! ? a : b));
  const mean =
    rows.reduce((sum, r) => sum + r.accuracy!, 0) / rows.length;
  if (worst.accuracy! >= mean - 3) return null;

  return {
    kind: "Accuracy dips",
    headline: `around move ${worst.move}`,
    detail: `${worst.accuracy!.toFixed(0)}% there, against ${mean.toFixed(0)}% across the game.`,
    section: "games",
    tone: "bad",
  };
}

/** How often a move is an outright blunder, and where they cluster. */
function blunderRate(data: Insights): Finding | null {
  if (data.engine_metrics === false) return null;
  const blunder = data.moves.quality.find((q) => q.cls === "blunder");
  if (!blunder || blunder.moves === 0) return null;

  const phases = Object.entries(data.phases.accuracy ?? {}).filter(
    ([, v]) => v != null
  ) as [string, number][];
  const worstPhase =
    phases.length >= 2
      ? phases.reduce((a, b) => (a[1] <= b[1] ? a : b))[0]
      : null;

  return {
    kind: "Blunder rate",
    headline: `${blunder.pct.toFixed(1)}% of your moves`,
    detail: worstPhase
      ? `${blunder.moves.toLocaleString()} in total; accuracy is lowest in the ${worstPhase}.`
      : `${blunder.moves.toLocaleString()} blunders across the games reviewed.`,
    section: "moves",
    tone: "bad",
  };
}

/** When they play best — the one finding that is allowed to be good news. */
function bestTime(data: Insights): Finding | null {
  const slots = data.calendar.time_of_day.filter((s) => s.games >= MIN_SPLIT_GAMES);
  if (slots.length < 2) return null;

  const best = slots.reduce((a, b) => (scoreOf(a) >= scoreOf(b) ? a : b));
  const worst = slots.reduce((a, b) => (scoreOf(a) <= scoreOf(b) ? a : b));
  if (scoreOf(best) - scoreOf(worst) < 0.1) return null;

  return {
    kind: "Best sessions",
    headline: `in the ${best.slot}`,
    detail: `${pctText(scoreOf(best))} there, against ${pctText(scoreOf(worst))} in the ${worst.slot}.`,
    section: "calendar",
    tone: "good",
  };
}

/**
 * Up to three findings, worst first, with the good-news one last if it earned
 * a place. Returns an empty list rather than filler when nothing clears its
 * threshold — no finding is a legitimate answer, and inventing one to fill the
 * row is how a diagnosis stops being trustworthy.
 */
export function findings(data: Insights): Finding[] {
  const bad = [worstOpening(data), accuracyDip(data), blunderRate(data)].filter(
    (f): f is Finding => f !== null
  );
  const good = bestTime(data);
  const out = [...bad];
  if (out.length < 3 && good) out.push(good);
  return out.slice(0, 3);
}
