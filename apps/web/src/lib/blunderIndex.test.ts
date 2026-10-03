import { describe, expect, it } from "vitest";

import type { Annotation, Classification } from "@/lib/api";
import { MAX_CHIPS, selectBlunders } from "./blunderIndex";

const ann = (ply: number, classification: Classification | null): Annotation =>
  ({ ply, classification, move_san: `m${ply}`, review: null, eval_cp: 0, best_uci: null }) as unknown as Annotation;

describe("selectBlunders", () => {
  it("ignores moves that are not mistakes", () => {
    const out = selectBlunders([ann(1, "best"), ann(2, "book"), ann(3, "excellent")]);
    expect(out.total).toBe(0);
    expect(out.kept).toEqual([]);
  });

  it("keeps everything, in game order, when it fits", () => {
    const out = selectBlunders([ann(9, "mistake"), ann(2, "blunder"), ann(5, "inaccuracy")]);
    expect(out.kept.map((a) => a.ply)).toEqual([2, 5, 9]);
    expect(out.hidden).toBe(0);
  });

  it("keeps the WORST when it overflows, not the earliest", () => {
    // The bug this exists to prevent: a single blunder late in a game full of
    // inaccuracies must survive the cut.
    const many = Array.from({ length: 30 }, (_, i) => ann(i, "inaccuracy"));
    const out = selectBlunders([...many, ann(99, "blunder")]);
    expect(out.kept).toHaveLength(MAX_CHIPS);
    expect(out.kept.some((a) => a.classification === "blunder")).toBe(true);
    expect(out.total).toBe(31);
    expect(out.hidden).toBe(31 - MAX_CHIPS);
  });

  it("does not refuse a whole tier just because it overflows the cap", () => {
    // One blunder plus twelve mistakes is 13, one over the cap. The first
    // implementation dropped the entire mistake tier and rendered ONE chip.
    const rows = [ann(0, "blunder"), ...Array.from({ length: 12 }, (_, i) => ann(i + 1, "mistake"))];
    const out = selectBlunders(rows);
    expect(out.kept).toHaveLength(MAX_CHIPS);
    expect(out.kept.filter((a) => a.classification === "mistake").length).toBe(11);
    expect(out.hidden).toBe(1);
  });

  it("returns chips in game order even after ranking by severity", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => ann(i * 2, "inaccuracy")),
      ann(3, "blunder"),
      ann(41, "mistake"),
    ];
    const plies = selectBlunders(rows).kept.map((a) => a.ply);
    expect([...plies].sort((a, b) => a - b)).toEqual(plies);
  });

  it("counts every qualifying mistake in the total, not just the shown ones", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ann(i, "mistake"));
    const out = selectBlunders(rows);
    expect(out.total).toBe(40);
    expect(out.kept).toHaveLength(MAX_CHIPS);
    expect(out.hidden).toBe(28);
  });
});
