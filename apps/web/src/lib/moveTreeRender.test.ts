import { describe, expect, it } from "vitest";
import { addLine, addMove, fromMoves, mainlinePath, type MoveTree, type NodeId } from "@/lib/moveTree";
import { renderTree, type Row, type VariationRow } from "@/lib/moveTreeRender";

const RUY = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];

const main = (t: MoveTree, n: number): NodeId => mainlinePath(t)[n].id;

/** A variation row as it reads on screen: "2... Nf6 3. Nxe5 ( 3. d3 )". */
const text = (row: VariationRow) =>
  row.tokens
    .map((t) => (t.t === "paren" ? t.text : [t.num, t.san].filter(Boolean).join(" ")))
    .join(" ");

const variations = (rows: Row[]) => rows.filter((r): r is VariationRow => r.kind === "variation");

describe("the game", () => {
  it("renders as numbered pairs", () => {
    const rows = renderTree(fromMoves(RUY));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === "pair")).toBe(true);
    expect(rows.map((r) => (r.kind === "pair" ? r.moveNo : 0))).toEqual([1, 2, 3]);
  });

  it("leaves the second half of an odd last move empty", () => {
    const rows = renderTree(fromMoves(["e4", "e5", "Nf3"]));
    const last = rows[1];
    expect(last.kind === "pair" && last.white).toBeTruthy();
    expect(last.kind === "pair" && last.black).toBeUndefined();
  });

  it("has nothing to say about an empty board", () => {
    expect(renderTree(fromMoves([]))).toEqual([]);
  });
});

describe("variations", () => {
  it("numbers a Black alternative with an ellipsis", () => {
    const t = addMove(fromMoves(RUY), main(fromMoves(RUY), 2), "Nf6").tree;
    expect(text(variations(renderTree(t))[0])).toBe("2... Nf6");
  });

  it("numbers a White alternative plainly", () => {
    const t0 = fromMoves(RUY);
    const t = addMove(t0, main(t0, 1), "Bc4").tree; // instead of 2. Nf3
    expect(text(variations(renderTree(t))[0])).toBe("2. Bc4");
  });

  it("gives every alternative at a point its own row, in the order tried", () => {
    const t0 = fromMoves(RUY);
    let t = addMove(t0, main(t0, 2), "Nf6").tree;
    t = addMove(t, main(t0, 2), "d6").tree;
    t = addMove(t, main(t0, 2), "f5").tree;

    expect(variations(renderTree(t)).map(text)).toEqual(["2... Nf6", "2... d6", "2... f5"]);
  });

  it("sits directly under the move it answers, not at the end", () => {
    const t0 = fromMoves(RUY);
    const t = addMove(t0, main(t0, 2), "Nf6").tree;
    const rows = renderTree(t);
    // 1. e4 e5 | 2. Nf3 Nc6 | (2... Nf6) | 3. Bb5 a6
    expect(rows.map((r) => r.kind)).toEqual(["pair", "pair", "variation", "pair"]);
  });

  it("flows on without renumbering every move", () => {
    const t0 = fromMoves(RUY);
    const t = addLine(t0, main(t0, 2), ["Nf6", "Nxe5", "d6", "Nf3"]).tree;
    expect(text(variations(renderTree(t))[0])).toBe("2... Nf6 3. Nxe5 d6 4. Nf3");
  });

  it("hangs a continuation past the end of the game off the last move", () => {
    const t0 = fromMoves(["e4", "e5"]);
    const t = addLine(t0, main(t0, 1), ["Nf3", "Nc6"]).tree;
    const rows = renderTree(t);
    expect(rows.map((r) => r.kind)).toEqual(["pair", "variation"]);
    expect(text(variations(rows)[0])).toBe("2. Nf3 Nc6");
  });
});

describe("lines inside lines", () => {
  it("tucks a short one into brackets beside the move it replaces", () => {
    const t0 = fromMoves(RUY);
    const a = addLine(t0, main(t0, 2), ["Nf6", "Nxe5", "d6"]);
    const t = addMove(a.tree, a.id, "d3").tree; // a one-move rival to 3. Nxe5

    // The bracket lands after Nxe5, which is what it answers - never before it.
    expect(text(variations(renderTree(t))[0])).toBe("2... Nf6 3. Nxe5 ( 3. d3 ) 3... d6");
  });

  it("renumbers the move that follows a bracket", () => {
    const t0 = fromMoves(RUY);
    const a = addLine(t0, main(t0, 2), ["Nf6", "Nxe5", "d6", "Nf3"]);
    const t = addMove(a.tree, a.id, "d3").tree;

    // d6 is Black's and would normally go bare, but the bracket broke the
    // reader's place, so it comes back numbered.
    expect(text(variations(renderTree(t))[0])).toBe("2... Nf6 3. Nxe5 ( 3. d3 ) 3... d6 4. Nf3");
  });

  it("gives a long one a row of its own, indented one further", () => {
    const t0 = fromMoves(RUY);
    const a = addLine(t0, main(t0, 2), ["Nf6", "Nxe5", "d6"]);
    const t = addLine(a.tree, a.id, ["d3", "d6", "Nc3", "Bg4", "Be2"]).tree;

    const rows = variations(renderTree(t));
    expect(rows).toHaveLength(2);
    expect(rows[0].depth).toBe(1);
    expect(text(rows[0])).toBe("2... Nf6 3. Nxe5 d6");
    expect(rows[1].depth).toBe(2);
    expect(text(rows[1])).toBe("3. d3 d6 4. Nc3 Bg4 5. Be2");
  });

  it("will not inline a line that itself branches", () => {
    const t0 = fromMoves(RUY);
    const a = addLine(t0, main(t0, 2), ["Nf6", "Nxe5"]);
    let t = addMove(a.tree, a.id, "d3").tree; // short rival to 3. Nxe5
    const d3 = t.nodes.get(a.id)!.children[1];
    t = addMove(t, d3, "Bc5").tree;
    t = addMove(t, d3, "d6").tree; // now d3 has two answers of its own

    // d3 is two plies and would fit in brackets, but it forks - so it is
    // broken out where its own alternatives have somewhere to go.
    const rows = variations(renderTree(t));
    expect(rows.map((r) => r.depth)).toEqual([1, 2]);
    expect(text(rows[0])).toBe("2... Nf6 3. Nxe5");
    expect(text(rows[1])).toBe("3. d3 Bc5 ( 3... d6 )");
  });
});
