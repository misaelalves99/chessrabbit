import { describe, expect, it } from "vitest";

import { MAX_DAYS, TICKS, intervalLabel, pos } from "./recallScale";

describe("pos", () => {
  it("pins a new or lapsed card to the left end", () => {
    expect(pos(0)).toBe(0);
    expect(pos(-1)).toBe(0);
    // A lapse returns RETRY_MINUTES/1440, which must land ON the mark and not
    // a few percent along it as though the card had made progress.
    expect(pos(10 / 1440)).toBe(0);
  });

  it("leaves a gap between the lapse position and the first real interval", () => {
    // The gap is the point: a lapsed card must not look like a card scheduled
    // in a few hours.
    expect(pos(1) - pos(0)).toBeGreaterThan(10);
    expect(pos(2 / 24)).toBeGreaterThan(3);
  });

  it("rises monotonically with the interval", () => {
    const days = [0, 0.5, 1, 3, 7, 21, 60, 180, 365];
    const xs = days.map(pos);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });

  it("stays inside the rule", () => {
    for (const d of [0, 1, 100, MAX_DAYS, 10_000]) {
      expect(pos(d)).toBeGreaterThanOrEqual(0);
      expect(pos(d)).toBeLessThanOrEqual(100);
    }
  });

  it("clamps anything past a year to the right-hand end", () => {
    expect(pos(MAX_DAYS)).toBe(100);
    expect(pos(MAX_DAYS * 5)).toBe(100);
  });

  it("spaces the labelled ticks far enough apart to read", () => {
    // 9px of a 460px rule is about where two 9px mono labels start touching.
    const xs = TICKS.map((t) => pos(t.days));
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThan(9);
  });

  it("keeps the whole SM-2 ladder on the scale", () => {
    // The API starts at 1 day and multiplies by ease each success. Six
    // successes at the default ease must not run off the end of the rule.
    let interval = 1;
    for (let i = 0; i < 6; i++) {
      expect(pos(interval)).toBeLessThanOrEqual(100);
      interval *= 2.5;
    }
  });
});

describe("intervalLabel", () => {
  it("says what a lapse actually means", () => {
    // The API returns RETRY_MINUTES/1440 for a wrong answer — a fraction of a
    // day, not zero. Rounding that into the hours branch printed "0 hours" on
    // every wrong answer in the app.
    expect(intervalLabel(10 / 1440)).toBe("10 minutes");
    expect(intervalLabel(1 / 1440)).toBe("a minute");
    expect(intervalLabel(0)).toBe("a moment");
  });

  it("uses the unit a person would use", () => {
    expect(intervalLabel(0.5)).toBe("12 hours");
    expect(intervalLabel(1)).toBe("tomorrow");
    expect(intervalLabel(6)).toBe("6 days");
    expect(intervalLabel(21)).toBe("21 days");
    expect(intervalLabel(60)).toBe("2 months");
    expect(intervalLabel(400)).toBe("1.1 years");
  });

  it("rounds before it pluralises", () => {
    // The interval is a float off `interval * ease`, so the ones are created
    // by the rounding rather than passed in.
    expect(intervalLabel(1.2)).toBe("tomorrow");
    expect(intervalLabel(34)).toBe("a month");
    expect(intervalLabel(1 / 24)).toBe("an hour");
    expect(intervalLabel(366)).toBe("a year");
  });

  it("never says '1 days'", () => {
    // Anchored: "1.1 years" is correct and must not trip this.
    for (let d = 0; d <= 800; d += 0.25) {
      expect(intervalLabel(d)).not.toMatch(/^1(\.0)? (days|months|hours|years)$/);
    }
  });
});
