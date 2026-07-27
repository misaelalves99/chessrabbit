/**
 * Chart palettes for Insights, validated rather than eyeballed.
 *
 * Surface is the panel colour (#111629); the app is dark-only, so there is one
 * set of steps, chosen for that surface.
 *
 * ---------------------------------------------------------------------------
 * OUTCOME (win / draw / loss) - a diverging scale, not a categorical one.
 *
 * Chess convention is green/grey/red and every site the user knows uses it, so
 * the hues stay. The catch: mid-green against mid-red measures ΔE 5.5 under
 * deuteranopia - the two most important colours on the page would be the same
 * colour to a red-green colourblind reader.
 *
 * The fix is that WIN AND LOSS ARE SEPARATED BY LIGHTNESS, not by hue: a light
 * green against a dark red measures ΔE 26.4 deutan / 36.9 tritan, and survives
 * greyscale printing too. Do not "correct" these two steps toward each other -
 * that is precisely the failure this spacing exists to avoid.
 *
 * Two categorical gates fail on this triad by design, because it is diverging:
 *   - the grey midpoint is below the chroma floor (a diverging midpoint is
 *     required to be neutral, never a hue)
 *   - the light green sits above the categorical lightness band (the band
 *     assumes equal-weight slots; the whole point here is unequal lightness)
 * The gates that do apply pass on ALL pairs: CVD ΔE 12.2, normal-vision 18.2,
 * contrast ≥ 3:1.
 *
 * Even so, outcome is never encoded by colour alone: segments are always in
 * win → draw → loss order, always directly labelled, and always legended.
 * ---------------------------------------------------------------------------
 */
export const OUTCOME = {
  win: "#8FD164",
  draw: "#6B7396",
  loss: "#B23A44",
} as const;

/**
 * Categorical slots, assigned in this fixed order and never cycled. Passes
 * every gate on the dark surface: lightness band, chroma floor, adjacent CVD
 * (worst ΔE 10.5 deutan), normal-vision floor (worst ΔE 20.5), contrast.
 *
 * The ORDER is the colourblind-safety mechanism, not decoration - amber and
 * green are deliberately kept apart. Re-ordering silently breaks it; re-run
 * the validator if you must.
 *
 * Past six categories, fold the tail into "Other" rather than inventing a
 * seventh hue.
 */
export const SERIES = [
  "#7C6BF5", // violet
  "#0A9BAA", // cyan
  "#BE8A1E", // amber
  "#D4589B", // magenta
  "#4E9E42", // green
  "#3B7FE0", // blue
] as const;

/** Single hue, light -> dark, for magnitude (accuracy columns). */
export const SEQUENTIAL = ["#BFC7FF", "#9AA3FA", "#7C6BF5", "#5B4BD1", "#3F32A3"];

export const AXIS = "#9AA3C9";
export const GRID = "rgba(255,255,255,0.07)";

/** Colour for slot `i`, folding anything past the palette into the last hue. */
export function seriesColor(i: number): string {
  return SERIES[Math.min(i, SERIES.length - 1)];
}

/** Sequential step for a 0..1 magnitude. */
export function sequentialColor(t: number): string {
  const i = Math.round(Math.max(0, Math.min(1, t)) * (SEQUENTIAL.length - 1));
  return SEQUENTIAL[i];
}

export const SHAPE_LABELS: Record<string, { label: string; blurb: string }> = {
  smooth: { label: "Smooth", blurb: "One side stayed on top; little changed." },
  grind: { label: "Grind", blurb: "Long and quiet — 40+ moves, few swings." },
  sudden: { label: "Sudden", blurb: "Calm, then one decisive swing." },
  sharp: { label: "Sharp", blurb: "Repeatedly volatile evaluation." },
  wild: { label: "Wild", blurb: "Volatile, and the advantage changed hands." },
};

export const TERMINATION_LABELS: Record<string, string> = {
  checkmate: "Checkmate",
  resignation: "Resignation",
  timeout: "Timeout",
  abandoned: "Abandonment",
  agreement: "Agreement",
  stalemate: "Stalemate",
  repetition: "Repetition",
  insufficient: "Insufficient material",
  fifty_move: "50-move rule",
  other: "Other",
};

export const SLOT_LABELS: Record<string, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  night: "Night",
};

export const PHASE_LABELS: Record<string, string> = {
  opening: "Opening",
  middlegame: "Middlegame",
  endgame: "Endgame",
  none: "Never castled",
};

/** Percentages that always sum to 100, so a stacked bar never shows a seam. */
export function shares(parts: number[]): number[] {
  const total = parts.reduce((a, b) => a + b, 0);
  if (total <= 0) return parts.map(() => 0);
  return parts.map((p) => (p / total) * 100);
}

export function pct(n: number, total: number): string {
  if (!total) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}
