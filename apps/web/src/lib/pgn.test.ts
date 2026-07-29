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
