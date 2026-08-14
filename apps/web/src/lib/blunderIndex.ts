import type { Annotation, Classification } from "@/lib/api";

/**
 * Which mistakes the blunder strip shows, and in what order.
 *
 * Kept out of the component because the selection rule is the part with a bug
 * in it: the first version dropped whole severity tiers when the list
 * overflowed, so a real game with one blunder and twelve mistakes rendered a
 * single chip and hid thirty-two — adding the mistake tier exceeded the cap by
 * one, and the whole tier was refused.
 */

/** The only verdicts worth interrupting for, worst first. */
export const LISTED: Classification[] = ["blunder", "mistake", "inaccuracy"];

/**
 * Beyond this many chips the strip stops being an index and becomes a wall.
 * A clean game has three or four; a scrappy one can have thirty-odd, which
 * wraps to five rows and pushes the move list off the panel.
 */
export const MAX_CHIPS = 12;

const SEVERITY: Record<string, number> = { blunder: 0, mistake: 1, inaccuracy: 2 };

export interface BlunderSelection {
  /** Chips to render, in game order. */
  kept: Annotation[];
  /** How many qualifying mistakes were left out. */
  hidden: number;
  /** Every qualifying mistake, for the count in the heading. */
  total: number;
}

export function selectBlunders(annotations: Annotation[]): BlunderSelection {
  const all = annotations
    .filter((a) => a.classification && LISTED.includes(a.classification))
    .sort((a, b) => a.ply - b.ply);

  if (all.length <= MAX_CHIPS) {
    return { kept: all, hidden: 0, total: all.length };
  }

  // Worst first, take what fits, then back into game order — the strip is an
  // index into the game, so it has to read chronologically.
  const kept = [...all]
    .sort(
      (a, b) =>
        SEVERITY[a.classification!] - SEVERITY[b.classification!] || a.ply - b.ply
    )
    .slice(0, MAX_CHIPS)
    .sort((a, b) => a.ply - b.ply);

  return { kept, hidden: all.length - kept.length, total: all.length };
}
