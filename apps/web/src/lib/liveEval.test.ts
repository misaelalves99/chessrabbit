import { describe, expect, it } from "vitest";
import {
  MATE_CP,
  PositionEval,
  classifyMove,
  explainMove,
  formatCp,
  lineToCp,
  liveVerdicts,
  terminalEval,
  toPositionEval,
  winPercent,
} from "@/lib/liveEval";
import { ROOT, addLine, addMove, fromMoves, mainlinePath, nodeAt } from "@/lib/moveTree";

/** A position score, with the fields a given test does not care about filled. */
const at = (cp: number, best?: string): PositionEval => ({
  cp,
  mate: null,
  depth: 20,
  bestUci: best ?? null,
  pv: best ? [best] : [],
});

describe("reading engine output", () => {
  it("folds a mate into the centipawn scale, keeping its side", () => {
    expect(lineToCp({ cp: null, mate: 3 })).toBe(MATE_CP);
    expect(lineToCp({ cp: null, mate: -3 })).toBe(-MATE_CP);
  });

  it("prefers the mate over any centipawn score reported alongside it", () => {
    expect(lineToCp({ cp: -40, mate: 2 })).toBe(MATE_CP);
  });

  it("keeps the engine's first choice, which is what makes a move 'best'", () => {
    const ev = toPositionEval({ depth: 22, multipv: 1, cp: 34, mate: null, pv: ["e2e4", "e7e5"] });
    expect(ev).toEqual({
      cp: 34,
      mate: null,
      depth: 22,
      bestUci: "e2e4",
      pv: ["e2e4", "e7e5"],
    });
  });

  it("has nothing to say about a line carrying no score", () => {
    expect(toPositionEval(undefined)).toBeNull();
    expect(toPositionEval({ depth: 1, multipv: 1, cp: null, mate: null, pv: [] })).toBeNull();
  });
});

describe("win percentage", () => {
  it("reads a dead level position as an even game", () => {
    expect(winPercent(0)).toBeCloseTo(50, 6);
  });

  it("is symmetric about zero, so a drop costs the same either colour", () => {
    expect(winPercent(250) - 50).toBeCloseTo(50 - winPercent(-250), 6);
  });

  it("flattens out once a position is winning, which is the whole point", () => {
    // The same 100cp costs far more in a level game than in a won one.
    const level = winPercent(100) - winPercent(0);
    const won = winPercent(1100) - winPercent(1000);
    expect(level).toBeGreaterThan(won * 3);
  });
});

describe("terminal positions", () => {
  it("scores checkmate by rule, against the side that has been mated", () => {
    // Fool's mate: Black has just mated, White to move.
    const mated = terminalEval("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
    expect(mated).toMatchObject({ cp: -MATE_CP, checkmate: true });
  });

  it("scores stalemate as the draw it is", () => {
    expect(terminalEval("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).toMatchObject({ cp: 0 });
  });

  it("leaves a live position to the engine", () => {
    expect(terminalEval("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBeNull();
  });
});

describe("classifying a move", () => {
  it("calls the engine's own first choice best", () => {
    const cls = classifyMove({
      before: at(30, "e2e4"),
      after: at(25),
      whiteMoved: true,
      playedUci: "e2e4",
    });
    expect(cls).toBe("best");
  });

  it("calls a move that delivers mate best, whatever the numbers say", () => {
    // Left alone, a jump to +10000 reads as a suspiciously large swing.
    const cls = classifyMove({
      before: at(50, "d1h5"),
      after: { cp: MATE_CP, mate: null, depth: 0, bestUci: null, pv: [], checkmate: true },
      whiteMoved: true,
      playedUci: "a2a3",
    });
    expect(cls).toBe("best");
  });

  it("grades White's move by how much of the game it gave away", () => {
    const grade = (afterCp: number) =>
      classifyMove({ before: at(0, "d2d4"), after: at(afterCp), whiteMoved: true, playedUci: "a2a3" });

    expect(grade(-20)).toBe("excellent");
    expect(grade(-40)).toBe("good");
    expect(grade(-100)).toBe("inaccuracy");
    expect(grade(-180)).toBe("mistake");
    expect(grade(-400)).toBe("blunder");
  });

  it("reads the same drop for Black, whose losses run the other way", () => {
    const grade = (afterCp: number) =>
      classifyMove({ before: at(0, "d7d5"), after: at(afterCp), whiteMoved: false, playedUci: "a7a6" });

    expect(grade(20)).toBe("excellent");
    expect(grade(100)).toBe("inaccuracy");
    expect(grade(400)).toBe("blunder");
  });

  it("never punishes a player for the position improving on their move", () => {
    const cls = classifyMove({
      before: at(-500, "d2d4"),
      after: at(500),
      whiteMoved: true,
      playedUci: "a2a3",
    });
    expect(cls).toBe("excellent");
  });
});

describe("verdicts across a tree", () => {
  const RUY = ["e4", "e5", "Nf3", "Nc6"];

  it("judges only the moves it holds the score on both sides of", () => {
    const tree = fromMoves(RUY);
    const main = mainlinePath(tree);

    // Scores for the root and the first move only.
    const known = new Map<string, PositionEval>([
      [nodeAt(tree, ROOT)!.fen, at(20, "e2e4")],
      [main[0].fen, at(15)],
    ]);
    const verdicts = liveVerdicts(tree, (fen) => known.get(fen) ?? null);

    expect([...verdicts.keys()]).toEqual([main[0].id]);
    expect(verdicts.get(main[0].id)!.cls).toBe("best");
  });

  it("scores a move in a line you tried, not the move it replaced", () => {
    const tree = fromMoves(RUY);
    const main = mainlinePath(tree);

    // 2...Nc6 was played; hang 2...f6 off the same position as an alternative.
    const alt = addMove(tree, main[2].id, "f6", { source: "user" });
    const played = nodeAt(alt.tree, main[3].id)!; // Nc6
    const tried = nodeAt(alt.tree, alt.id)!; // f6
    const before = nodeAt(alt.tree, main[2].id)!; // after Nf3

    const known = new Map<string, PositionEval>([
      [before.fen, at(30, "b8c6")],
      [played.fen, at(30)],
      [tried.fen, at(600)], // f6 is a disaster
    ]);
    const verdicts = liveVerdicts(alt.tree, (fen) => known.get(fen) ?? null);

    expect(verdicts.get(played.id)!.cls).toBe("best");
    expect(verdicts.get(tried.id)!.cls).toBe("blunder");
  });

  it("carries the score and the shallower of the two depths behind it", () => {
    const tree = fromMoves(["e4"]);
    const move = mainlinePath(tree)[0];
    const known = new Map<string, PositionEval>([
      [nodeAt(tree, ROOT)!.fen, { cp: 20, mate: null, depth: 12, bestUci: "e2e4", pv: [] }],
      [move.fen, { cp: 18, mate: null, depth: 26, bestUci: null, pv: [] }],
    ]);

    const v = liveVerdicts(tree, (fen) => known.get(fen) ?? null).get(move.id)!;
    expect(v.cp).toBe(18);
    expect(v.depth).toBe(12);
  });

  it("says nothing at all when the engine has answered nothing", () => {
    const tree = addLine(fromMoves(["e4", "e5"]), ROOT, ["d4"], { source: "user" }).tree;
    expect(liveVerdicts(tree, () => null).size).toBe(0);
  });
});

describe("saying why", () => {
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  /** White queen to g6, where a black pawn on f7 simply takes it. */
  const HANG_BEFORE = "4k3/5p2/8/8/8/8/8/4K1Q1 w - - 0 1";
  const HANG_AFTER = "4k3/5p2/6Q1/8/8/8/8/4K3 b - - 1 1";

  it("names the piece left hanging, and the capture that wins it", () => {
    const why = explainMove({
      cls: "blunder",
      before: { cp: 900, mate: null, depth: 20, bestUci: "g1g7", pv: ["g1g7"] },
      after: { cp: 0, mate: null, depth: 20, bestUci: "f7g6", pv: ["f7g6"] },
      beforeFen: HANG_BEFORE,
      afterFen: HANG_AFTER,
      playedUci: "g1g6",
      whiteMoved: true,
    });
    expect(why).toContain("leaves the queen on g6 en prise");
    expect(why).toContain("fxg6 wins material");
    expect(why.startsWith("A blunder.")).toBe(true);
  });

  it("does not cry en prise when the reply captures something else", () => {
    const why = explainMove({
      cls: "blunder",
      before: { cp: 900, mate: null, depth: 20, bestUci: "g1g7", pv: ["g1g7"] },
      // Black answers by moving the pawn, not by taking on g6.
      after: { cp: 0, mate: null, depth: 20, bestUci: "f7f5", pv: ["f7f5"] },
      beforeFen: HANG_BEFORE,
      afterFen: HANG_AFTER,
      playedUci: "g1g6",
      whiteMoved: true,
    });
    expect(why).not.toContain("en prise");
    expect(why).toContain("swings by");
  });

  it("reports a forced mate that was thrown away", () => {
    const why = explainMove({
      cls: "blunder",
      before: { cp: MATE_CP, mate: 2, depth: 20, bestUci: "e2e4", pv: ["e2e4"] },
      after: at(30),
      beforeFen: START,
      afterFen: START,
      playedUci: "a2a3",
      whiteMoved: true,
    });
    expect(why).toContain("There was a forced mate in 2 starting with e4.");
  });

  it("reports a forced mate that was handed to the opponent", () => {
    const why = explainMove({
      cls: "blunder",
      before: at(30, "e2e4"),
      after: { cp: -MATE_CP, mate: -3, depth: 20, bestUci: null, pv: [] },
      beforeFen: START,
      afterFen: START,
      playedUci: "a2a3",
      whiteMoved: true,
    });
    expect(why).toContain("This allows a forced mate in 3.");
  });

  it("falls back to the swing, and suggests the line it should have been", () => {
    const why = explainMove({
      cls: "mistake",
      before: {
        cp: 120,
        mate: null,
        depth: 20,
        bestUci: "e2e4",
        pv: ["e2e4", "e7e5", "g1f3"],
      },
      after: at(-30),
      beforeFen: START,
      afterFen: START,
      playedUci: "a2a3",
      whiteMoved: true,
    });
    expect(why).toContain("The evaluation swings by 1.5 pawns.");
    expect(why).toContain("Better was e4 (e4 e5 Nf3).");
  });

  it("credits a good move rather than explaining it away", () => {
    const best = explainMove({
      cls: "best",
      before: at(30, "e2e4"),
      after: at(25),
      beforeFen: START,
      afterFen: START,
      playedUci: "e2e4",
      whiteMoved: true,
    });
    expect(best).toBe("Best move — the engine's top choice.");
  });

  it("says a mate kept on track is still the best move", () => {
    const why = explainMove({
      cls: "best",
      before: { cp: MATE_CP, mate: 3, depth: 20, bestUci: "e2e4", pv: ["e2e4"] },
      after: { cp: MATE_CP, mate: 2, depth: 20, bestUci: null, pv: [] },
      beforeFen: START,
      afterFen: START,
      playedUci: "e2e4",
      whiteMoved: true,
    });
    expect(why).toBe("Best move — keeps the forced mate in 2 on track.");
  });

  it("calls checkmate checkmate, whatever the classifier thought", () => {
    const why = explainMove({
      cls: "blunder",
      before: at(0, "e2e4"),
      after: { cp: MATE_CP, mate: null, depth: 0, bestUci: null, pv: [], checkmate: true },
      beforeFen: START,
      afterFen: START,
      playedUci: "a2a3",
      whiteMoved: true,
    });
    expect(why).toBe("Checkmate.");
  });
});

describe("formatting", () => {
  it("signs a score the way the eval bar does", () => {
    expect(formatCp(0)).toBe("+0.00");
    expect(formatCp(34)).toBe("+0.34");
    expect(formatCp(-120)).toBe("-1.20");
  });

  it("shows a forced mate as a mate rather than a hundred pawns", () => {
    expect(formatCp(MATE_CP)).toBe("+M");
    expect(formatCp(-MATE_CP)).toBe("-M");
  });
});
