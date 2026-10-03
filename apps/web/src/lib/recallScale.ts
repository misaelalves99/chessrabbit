/**
 * The scale behind the Recall Rule (components/RecallRule.tsx).
 *
 * Kept out of the component so it can be tested directly: the rule is the one
 * place in the UI where a wrong number is invisible rather than obviously
 * broken — a needle three pixels off still looks like a needle.
 */

/** Labelled stops on the rule. Values in days; 0 is the lapse/new position. */
export const TICKS: { days: number; label: string }[] = [
  { days: 0, label: "new" },
  { days: 1, label: "1d" },
  { days: 3, label: "3d" },
  { days: 7, label: "1w" },
  { days: 21, label: "3w" },
  { days: 60, label: "2mo" },
  { days: 180, label: "6mo" },
];

/** Unlabelled minor ticks, for the texture of a real scale. */
export const MINOR = [0.5, 2, 4, 5, 10, 14, 30, 45, 90, 120, 270];

/** Anything scheduled past a year is pinned to the right-hand end. */
export const MAX_DAYS = 365;

/**
 * Intervals below this land on the lapse mark rather than on the log curve.
 *
 * A lapsed card does NOT come back as `0` days: the API returns
 * `RETRY_MINUTES / 1440`, a small positive fraction. Treating that as an
 * ordinary interval put the needle a few percent along the rule — visibly off
 * the "new" tick, as though a card you had just failed had made some progress.
 * An hour is the cutoff because nothing in SM-2 schedules between ten minutes
 * and a day; anything under it is the retry queue, which is the same place as
 * the start.
 */
const LAPSE_DAYS = 1 / 24;

/**
 * Days -> position along the rule, 0–100.
 *
 * Logarithmic, because the intervals are: the API multiplies by ease (1.3–2.8)
 * on every success, so a linear rule would put every early review in the first
 * inch and leave four fifths of the brass empty.
 *
 * A new or just-lapsed card sits hard against the left end rather than on the
 * log curve, so "you lost this one" is a distinct place on the scale and not
 * merely a very small number.
 */
export function pos(days: number): number {
  if (days < LAPSE_DAYS) return 0;
  const t = Math.log1p(Math.min(days, MAX_DAYS)) / Math.log1p(MAX_DAYS);
  return 4 + 96 * t;
}

/**
 * How an interval reads out loud, in the units a person would use.
 *
 * Every branch rounds BEFORE it decides whether the unit is plural, because
 * the interval is a float coming off `interval * ease` and the rounding is
 * what creates the ones: 1.2 days and 34 days both round down to a single
 * unit, and "1 days" / "1 months" is exactly the sort of thing that makes a
 * careful interface look careless.
 */
export function intervalLabel(days: number): string {
  if (days <= 0) return "a moment";

  // A lapse comes back in RETRY_MINUTES, which is a fraction of an hour. The
  // hours branch alone rounded that to "0 hours" — the readout on every wrong
  // answer, and a sentence that means nothing.
  if (days < 1 / 24) {
    const mins = Math.max(1, Math.round(days * 1440));
    return mins === 1 ? "a minute" : `${mins} minutes`;
  }

  if (days < 1) {
    const hours = Math.round(days * 24);
    return hours === 1 ? "an hour" : `${hours} hours`;
  }

  if (days < 30) {
    const d = Math.round(days);
    return d === 1 ? "tomorrow" : `${d} days`;
  }

  if (days < 365) {
    const months = Math.round(days / 30);
    return months === 1 ? "a month" : `${months} months`;
  }

  const years = days / 365;
  return years < 1.05 ? "a year" : `${years.toFixed(1)} years`;
}
