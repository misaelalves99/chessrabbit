import { describe, expect, it } from "vitest";

import type { Insights } from "@/lib/api";
import { findings } from "./findings";

/** A minimal Insights with everything empty; tests fill in what they need. */
function base(over: Partial<Insights> = {}): Insights {
  return {
    filters: { time_class: null, color: null, since: null, tz_offset: 0 },
    games: 200,
    reviewed: 200,
    unattributed: 0,
    replay_limit: 0,
    overview: {
      played: 200,
      wins: 100,
      draws: 0,
      losses: 100,
      by_month: [],
      accuracy: {},
      accuracy_by_move: [],
      by_opponent_rating: [],
    },
    results: { won_by: [], drew_by: [], lost_by: [] },
    phases: {},
    shapes: {},
    openings: { white: [], black: [] },
    moves: { quality: [], quality_by_month: {}, pieces: [], castling: {} },
    calendar: { time_of_day: [], day_of_week: [] },
    ...over,
  } as Insights;
}

const opening = (name: string, games: number, wins: number) => ({
  name, eco: null, games, wins, draws: 0, losses: games - wins,
});

describe("findings", () => {
  it("says nothing when there is nothing to say", () => {
    expect(findings(base())).toEqual([]);
  });

  it("never draws an opening conclusion from a tiny sample", () => {
    // 0% in 3 games is noise. It must not be reported however bad it looks.
    const data = base({
      openings: {
        white: [opening("Vienna", 3, 0), opening("Italian", 80, 40)],
        black: [],
      },
    });
    expect(findings(data).some((f) => f.headline.includes("Vienna"))).toBe(false);
  });

  it("reports an opening that is genuinely below the player's own baseline", () => {
    const data = base({
      openings: {
        white: [opening("Italian", 100, 55)],
        black: [opening("French", 20, 4)],
      },
    });
    const f = findings(data).find((x) => x.kind === "Weakest line");
    expect(f).toBeDefined();
    expect(f!.headline).toBe("French as Black");
    expect(f!.detail).toContain("20 games");
    expect(f!.section).toBe("openings");
  });

  it("stays quiet when every opening sits near the baseline", () => {
    const data = base({
      openings: {
        white: [opening("Italian", 50, 25), opening("Ruy Lopez", 50, 24)],
        black: [],
      },
    });
    expect(findings(data).some((f) => f.kind === "Weakest line")).toBe(false);
  });

  it("skips engine-derived findings for a player with no engine metrics", () => {
    // Another player's games carry no annotations. Reporting "0.0% blunders"
    // there would be a lie dressed as a compliment.
    const data = base({
      engine_metrics: false,
      moves: {
        quality: [{ cls: "blunder", moves: 0, pct: 0 }],
        quality_by_month: {}, pieces: [], castling: {},
      },
      overview: {
        ...base().overview,
        accuracy_by_move: [
          { move: 10, accuracy: 90, moves: 500 },
          { move: 20, accuracy: 60, moves: 500 },
          { move: 30, accuracy: 88, moves: 500 },
        ],
      },
    });
    const kinds = findings(data).map((f) => f.kind);
    expect(kinds).not.toContain("Blunder rate");
    expect(kinds).not.toContain("Accuracy dips");
  });

  it("finds the move number where accuracy falls off", () => {
    const data = base({
      overview: {
        ...base().overview,
        accuracy_by_move: [
          { move: 10, accuracy: 88, moves: 400 },
          { move: 20, accuracy: 71, moves: 400 },
          { move: 30, accuracy: 86, moves: 400 },
        ],
      },
    });
    const f = findings(data).find((x) => x.kind === "Accuracy dips");
    expect(f!.headline).toBe("around move 20");
  });

  it("ignores move buckets with too few moves behind them", () => {
    const data = base({
      overview: {
        ...base().overview,
        accuracy_by_move: [
          { move: 10, accuracy: 88, moves: 400 },
          { move: 60, accuracy: 20, moves: 4 },
          { move: 30, accuracy: 86, moves: 400 },
        ],
      },
    });
    const f = findings(data).find((x) => x.kind === "Accuracy dips");
    expect(f?.headline).not.toBe("around move 60");
  });

  it("reports the good-news finding only when the gap is real", () => {
    const near = base({
      calendar: {
        time_of_day: [
          { slot: "morning", games: 100, wins: 52, draws: 0, losses: 48 },
          { slot: "night", games: 100, wins: 50, draws: 0, losses: 50 },
        ],
        day_of_week: [],
      },
    });
    expect(near.calendar.time_of_day.length).toBe(2);
    expect(findings(near).some((f) => f.kind === "Best sessions")).toBe(false);

    const wide = base({
      calendar: {
        time_of_day: [
          { slot: "morning", games: 100, wins: 70, draws: 0, losses: 30 },
          { slot: "night", games: 100, wins: 40, draws: 0, losses: 60 },
        ],
        day_of_week: [],
      },
    });
    const f = findings(wide).find((x) => x.kind === "Best sessions");
    expect(f!.headline).toBe("in the morning");
    expect(f!.tone).toBe("good");
  });

  it("never returns more than three, and leads with the problems", () => {
    const data = base({
      openings: { white: [opening("Italian", 100, 55)], black: [opening("French", 20, 3)] },
      overview: {
        ...base().overview,
        accuracy_by_move: [
          { move: 10, accuracy: 88, moves: 400 },
          { move: 20, accuracy: 68, moves: 400 },
          { move: 30, accuracy: 87, moves: 400 },
        ],
      },
      moves: {
        quality: [{ cls: "blunder", moves: 340, pct: 3.4 }],
        quality_by_month: {}, pieces: [], castling: {},
      },
      calendar: {
        time_of_day: [
          { slot: "morning", games: 100, wins: 70, draws: 0, losses: 30 },
          { slot: "night", games: 100, wins: 40, draws: 0, losses: 60 },
        ],
        day_of_week: [],
      },
    });
    const f = findings(data);
    expect(f).toHaveLength(3);
    expect(f.every((x) => x.tone === "bad")).toBe(true);
  });
});
