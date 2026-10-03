import { describe, expect, it } from "vitest";
import { mainlinePath, nodeAt } from "@/lib/moveTree";
import { parsePgn, toPgn } from "@/lib/pgn";

/** The movetext alone, which is what these tests are actually about. */
const body = (pgn: string) => pgn.split("\n\n")[1].trim();

const roundTrip = (pgn: string) => body(toPgn(parsePgn(pgn).tree));

const sans = (pgn: string) => mainlinePath(parsePgn(pgn).tree).map((n) => n.san);

describe("reading", () => {
  it("keeps the variation chess.js throws away", () => {
    const src = `1. e4 e5 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 3. Bb5 a6`;
    const { tree } = parsePgn(src);

    expect(mainlinePath(tree).map((n) => n.san)).toEqual([
      "e4",
      "e5",
      "Nf3",
      "Nc6",
      "Bb5",
      "a6",
    ]);
    // The bracket hangs off e5, beside Nf3 - not after it.
    const e5 = mainlinePath(tree)[1];
    expect(e5.children).toHaveLength(2);
    expect(nodeAt(tree, e5.children[1])!.san).toBe("Bc4");
    expect(nodeAt(tree, e5.children[1])!.mainline).toBe(false);
  });

  it("reads headers and leaves them out of the moves", () => {
    const { headers, tree } = parsePgn(
      `[Event "Casual"]\n[White "shiva"]\n[Result "1-0"]\n\n1. e4 e5 1-0`
    );
    expect(headers.Event).toBe("Casual");
    expect(headers.White).toBe("shiva");
    expect(mainlinePath(tree).map((n) => n.san)).toEqual(["e4", "e5"]);
  });

  it("carries comments and NAGs onto the move they belong to", () => {
    const { tree } = parsePgn(`1. e4 {best by test} e5 $2 2. Nf3!?`);
    const [e4, e5, nf3] = mainlinePath(tree);
    expect(e4.comment).toBe("best by test");
    expect(e5.nag).toBe(2);
    expect(nf3.nag).toBe(5); // !? written as a suffix
  });

  it("nests a bracket inside a bracket", () => {
    const { tree } = parsePgn(`1. e4 e5 2. Nf3 (2. Bc4 Nf6 (2... Bc5 3. d3) 3. d4)`);
    const bc4 = nodeAt(tree, mainlinePath(tree)[1].children[1])!;
    const nf6 = nodeAt(tree, bc4.children[0])!;
    expect(nf6.san).toBe("Nf6");
    expect(nodeAt(tree, bc4.children[1])!.san).toBe("Bc5");
    expect(nodeAt(tree, bc4.children[1])!.depth).toBe(2);
  });

  it("loses only the line a bad move is in", () => {
    const { tree } = parsePgn(`1. e4 e5 2. Nf3 (2. Qxf7 Nf6) 2... Nc6 3. Bb5`);
    expect(mainlinePath(tree).map((n) => n.san)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(mainlinePath(tree)[1].children).toHaveLength(1); // the bad line is gone
  });

  it("shrugs off results, move numbers and stray remarks", () => {
    expect(sans(`1. e4 e5 2. Nf3 Nc6 1/2-1/2`)).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(sans(`1.e4 e5 2.Nf3 ; trailing note\nNc6 *`)).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(sans(``)).toEqual([]);
  });
});

describe("writing", () => {
  it("puts a variation back where it came from", () => {
    expect(roundTrip(`1. e4 e5 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 3. Bb5 a6`)).toBe(
      `1. e4 e5 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 3. Bb5 a6 *`
    );
  });

  it("renumbers Black's move after a bracket or a comment", () => {
    expect(roundTrip(`1. e4 e5 2. Nf3 (2. d4) 2... Nc6`)).toBe(
      `1. e4 e5 2. Nf3 (2. d4) 2... Nc6 *`
    );
    expect(roundTrip(`1. e4 {a note} e5`)).toBe(`1. e4 {a note} 1... e5 *`);
  });

  it("writes NAGs back as the suffixes they came from", () => {
    expect(roundTrip(`1. e4 e5 2. Nf3 $1 Nc6 $6`)).toBe(`1. e4 e5 2. Nf3! Nc6?! *`);
  });

  it("survives a second trip unchanged", () => {
    const src = `1. e4 e5 2. Nf3 (2. Bc4 Nf6 (2... Bc5 3. d3) 3. d4) 2... Nc6 {main} 3. Bb5!`;
    const once = roundTrip(src);
    expect(roundTrip(once)).toBe(once);
  });

  it("emits a header block and a result", () => {
    const out = toPgn(parsePgn(`1. e4 e5`).tree, { White: "shiva", Result: "1-0" });
    expect(out).toContain(`[White "shiva"]`);
    expect(out).toContain(`[Result "1-0"]`);
    expect(body(out)).toBe(`1. e4 e5 1-0`);
  });

  it("has something valid to say about an empty game", () => {
    expect(body(toPgn(parsePgn(``).tree))).toBe(`*`);
  });
});

/**
 * A study chapter says something about the position before anything is played
 * — its introduction, and the arrows drawn over the opening array. PGN puts
 * that in a comment ahead of the first move.
 */
describe("the starting position's own comment", () => {
  it("reads a comment before the first move onto the root", () => {
    const { tree } = parsePgn(`{how this line goes} 1. e4 e5`);
    expect(nodeAt(tree, tree.root)!.comment).toBe("how this line goes");
    expect(sans(`{how this line goes} 1. e4 e5`)).toEqual(["e4", "e5"]);
  });

  it("writes it back ahead of the moves", () => {
    expect(roundTrip(`{intro} 1. e4 e5`)).toBe(`{intro} 1. e4 e5 *`);
  });

  it("keeps one on a chapter with no moves in it yet", () => {
    expect(roundTrip(`{an empty board and a plan}`)).toBe(`{an empty board and a plan} *`);
  });

  // Between `(` and the variation's first move the cursor sits on the root.
  // A comment written there is about that line, and must not be hoisted into
  // the game's introduction.
  it("does not mistake a variation's opening comment for the root's", () => {
    const { tree } = parsePgn(`1. e4 e5 2. Nf3 ({the other way} 2. Bc4 Nf6) 2... Nc6`);
    expect(nodeAt(tree, tree.root)!.comment).toBeUndefined();
  });
});

/**
 * A study chapter can start from a diagram rather than the opening array. The
 * position travels in the headers, and the move numbers have to follow it -
 * numbering an endgame from 1 is the tell that the tree's own ply leaked out.
 */
describe("chapters that start from a position", () => {
  const rook = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 41";
  const blackFirst = "4k3/8/8/8/8/8/4P3/4K3 b - - 0 41";

  it("stands the tree on the FEN header", () => {
    const { tree } = parsePgn(`[SetUp "1"]\n[FEN "${rook}"]\n\n41. e4`);
    expect(nodeAt(tree, tree.root)!.fen).toBe(rook);
    expect(mainlinePath(tree).map((n) => n.san)).toEqual(["e4"]);
  });

  it("numbers from the position, not from the root", () => {
    expect(roundTrip(`[SetUp "1"]\n[FEN "${rook}"]\n\n41. e4 Kd7`)).toBe(`41. e4 Kd7 *`);
  });

  it("keeps Black-to-move numbering", () => {
    expect(roundTrip(`[SetUp "1"]\n[FEN "${blackFirst}"]\n\n41... Kd7 42. e4`)).toBe(
      `41... Kd7 42. e4 *`
    );
  });

  it("writes the SetUp/FEN pair back out", () => {
    const out = toPgn(parsePgn(`[SetUp "1"]\n[FEN "${rook}"]\n\n41. e4`).tree);
    expect(out).toContain(`[SetUp "1"]`);
    expect(out).toContain(`[FEN "${rook}"]`);
  });

  // The moves were played on the board the tree holds. A FEN tag carried in
  // from somewhere else must not be allowed to say they were played elsewhere.
  it("drops a FEN header that the tree does not stand on", () => {
    const out = toPgn(parsePgn(`1. e4 e5`).tree, { FEN: rook, SetUp: "1" });
    expect(out).not.toContain("[FEN");
    expect(out).not.toContain("[SetUp");
  });

  it("falls back to the opening array when the FEN is nonsense", () => {
    const { tree } = parsePgn(`[FEN "not a position"]\n\n1. e4`);
    expect(mainlinePath(tree).map((n) => n.san)).toEqual(["e4"]);
  });
});
