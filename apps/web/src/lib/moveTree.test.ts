import { describe, expect, it } from "vitest";
import {
  ROOT,
  addLine,
  addMove,
  canPromoteToMainline,
  clearVariations,
  createTree,
  deleteSubtree,
  endOfLine,
  fromMoves,
  mainlinePath,
  nearestMainline,
  nodeAt,
  promoteSibling,
  promoteToMainline,
  siblingBy,
  startOfLine,
  type MoveTree,
  type NodeId,
} from "@/lib/moveTree";

const RUY = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];

/** The nth move of the game, 0-based. */
const main = (t: MoveTree, n: number): NodeId => mainlinePath(t)[n].id;

const sans = (t: MoveTree) => mainlinePath(t).map((n) => n.san);

describe("building", () => {
  it("lays a PGN's moves out as the main line and locks it", () => {
    const t = fromMoves(RUY);
    expect(sans(t)).toEqual(RUY);
    expect(t.locked).toBe(true);
    expect(mainlinePath(t).every((n) => n.mainline && n.depth === 0)).toBe(true);
    expect(mainlinePath(t).map((n) => n.ply)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("stops at the first illegal move rather than throwing the rest away", () => {
    expect(sans(fromMoves(["e4", "e5", "Qxf7"]))).toEqual(["e4", "e5"]);
  });

  it("records the move in both notations, and the position after it", () => {
    const t = fromMoves(["e4"]);
    const n = nodeAt(t, main(t, 0))!;
    expect(n.san).toBe("e4");
    expect(n.uci).toBe("e2e4");
    expect(n.fen.split(" ")[1]).toBe("b"); // the position after e4: Black to move
  });
});

describe("adding moves", () => {
  it("branches instead of truncating - the whole point", () => {
    const t0 = fromMoves(RUY);
    // Question Black's 2nd move: play Nf6 from the position after 2. Nf3.
    const { tree, id } = addMove(t0, main(t0, 2), "Nf6");

    expect(sans(tree)).toEqual(RUY); // the game is untouched
    expect(nodeAt(tree, id)!.san).toBe("Nf6");
    expect(nodeAt(tree, id)!.mainline).toBe(false);
    expect(nodeAt(tree, id)!.depth).toBe(1);
    expect(nodeAt(tree, main(t0, 2))!.children).toHaveLength(2);
  });

  it("re-enters an existing branch rather than duplicating it", () => {
    const t0 = fromMoves(RUY);
    const a = addMove(t0, main(t0, 2), "Nf6");
    const b = addMove(a.tree, main(t0, 2), "Nf6");
    expect(b.id).toBe(a.id);
    expect(b.tree.nodes.size).toBe(a.tree.nodes.size);
  });

  it("walking the game forward stays on the game", () => {
    const t0 = fromMoves(RUY);
    // Nc6 is already the continuation; playing it must not fork.
    const { tree, id } = addMove(t0, main(t0, 2), "Nc6");
    expect(id).toBe(main(t0, 3));
    expect(nodeAt(tree, id)!.mainline).toBe(true);
  });

  it("leaves an illegal move where it found you", () => {
    const t0 = fromMoves(RUY);
    const { tree, id } = addMove(t0, main(t0, 2), "Qxf7");
    expect(id).toBe(main(t0, 2));
    expect(tree).toBe(t0);
  });

  it("extends the main line on a free board", () => {
    let t = createTree();
    let at = ROOT;
    for (const san of ["d4", "d5"]) ({ tree: t, id: at } = addMove(t, at, san));
    expect(sans(t)).toEqual(["d4", "d5"]);
    expect(nodeAt(t, at)!.mainline).toBe(true);
    expect(nodeAt(t, at)!.depth).toBe(0);
  });

  it("will not extend a game that is already over", () => {
    const t0 = fromMoves(["e4", "e5"]);
    const { tree, id } = addMove(t0, main(t0, 1), "Nf3");
    expect(sans(tree)).toEqual(["e4", "e5"]); // still two moves
    expect(nodeAt(tree, id)!.mainline).toBe(false);
    expect(nodeAt(tree, id)!.depth).toBe(1);
  });

  it("nests a line questioned inside a line", () => {
    const t0 = fromMoves(RUY);
    const a = addMove(t0, main(t0, 2), "Nf6"); // depth 1
    const b = addMove(a.tree, a.id, "Nxe5"); // continues it: still depth 1
    const c = addMove(b.tree, a.id, "d3"); // an alternative to that: depth 2

    expect(nodeAt(c.tree, b.id)!.depth).toBe(1);
    expect(nodeAt(c.tree, c.id)!.depth).toBe(2);
  });

  it("adds a whole engine line at once and points at its first move", () => {
    const t0 = fromMoves(RUY);
    const { tree, id } = addLine(t0, main(t0, 2), ["Nf6", "Nxe5", "d6"], {
      source: "engine",
      evalCp: 31,
    });
    const head = nodeAt(tree, id)!;
    expect(head.san).toBe("Nf6");
    expect(head.source).toBe("engine");
    expect(head.evalCp).toBe(31);
    expect(endOfLine(tree, id)).not.toBe(id);
    expect(nodeAt(tree, endOfLine(tree, id))!.san).toBe("d6");
  });
});

describe("navigating", () => {
  const built = () => {
    const t0 = fromMoves(RUY);
    const a = addMove(t0, main(t0, 2), "Nf6");
    const b = addMove(a.tree, main(t0, 2), "d6");
    const c = addMove(b.tree, main(t0, 2), "f5");
    return { tree: c.tree, alts: [a.id, b.id, c.id], fork: main(t0, 2) };
  };

  it("cycles the alternatives at a point", () => {
    const { tree, alts } = built();
    // Nc6 (the game) plus the three questions makes four options.
    expect(siblingBy(tree, alts[0], 1)).toBe(alts[1]);
    expect(siblingBy(tree, alts[2], 1)).toBe(mainlinePath(tree)[3].id); // wraps
    expect(siblingBy(tree, alts[0], -1)).toBe(mainlinePath(tree)[3].id);
  });

  it("finds the way back to the game", () => {
    const { tree, alts, fork } = built();
    const deep = addMove(tree, alts[0], "Nxe5");
    expect(nearestMainline(deep.tree, deep.id)).toBe(fork);
    expect(nearestMainline(tree, mainlinePath(tree)[4].id)).toBe(mainlinePath(tree)[4].id);
  });

  it("knows where a line starts and ends", () => {
    const { tree, alts } = built();
    const deep = addLine(tree, alts[0], ["Nxe5", "d6"]);
    const last = endOfLine(deep.tree, alts[0]);
    expect(nodeAt(deep.tree, last)!.san).toBe("d6");
    expect(startOfLine(deep.tree, last)).toBe(alts[0]);
  });
});

describe("editing", () => {
  it("refuses to delete the game", () => {
    const t = fromMoves(RUY);
    const before = t.nodes.size;
    const r = deleteSubtree(t, main(t, 3));
    expect(r.tree.nodes.size).toBe(before);
    expect(sans(r.tree)).toEqual(RUY);
  });

  it("deletes a variation and everything under it", () => {
    const t0 = fromMoves(RUY);
    const a = addLine(t0, main(t0, 2), ["Nf6", "Nxe5", "d6"]);
    const r = deleteSubtree(a.tree, a.id);
    expect(r.tree.nodes.size).toBe(t0.nodes.size);
    expect(r.id).toBe(main(t0, 2)); // the cursor lands on the branch point
    expect(sans(r.tree)).toEqual(RUY);
  });

  it("clears every alternative but keeps the continuation", () => {
    const t0 = fromMoves(RUY);
    let t = addMove(t0, main(t0, 2), "Nf6").tree;
    t = addMove(t, main(t0, 2), "d6").tree;
    expect(nodeAt(t, main(t0, 2))!.children).toHaveLength(3);

    t = clearVariations(t, main(t0, 2));
    expect(nodeAt(t, main(t0, 2))!.children).toHaveLength(1);
    expect(sans(t)).toEqual(RUY);
  });

  it("reorders variations without ever displacing the game", () => {
    const t0 = fromMoves(RUY);
    const a = addMove(t0, main(t0, 2), "Nf6");
    const b = addMove(a.tree, main(t0, 2), "d6");
    const fork = main(t0, 2);

    const up = promoteSibling(b.tree, b.id);
    expect(nodeAt(up, fork)!.children).toEqual([main(t0, 3), b.id, a.id]);

    // Nudging the first variation again cannot take slot 0 from the game.
    const again = promoteSibling(up, b.id);
    expect(nodeAt(again, fork)!.children[0]).toBe(main(t0, 3));
  });

  it("will not promote a variation over a reviewed game", () => {
    const t0 = fromMoves(RUY);
    const a = addMove(t0, main(t0, 2), "Nf6");
    expect(canPromoteToMainline(a.tree, a.id)).toBe(false);
    expect(promoteToMainline(a.tree, a.id)).toBe(a.tree);
  });

  it("promotes on a free board, and the flags follow", () => {
    let t = createTree();
    let at: NodeId = ROOT;
    for (const san of ["e4", "e5", "Nf3"]) ({ tree: t, id: at } = addMove(t, at, san));
    const alt = addMove(t, main(t, 1), "Bc4"); // a rival to 2. Nf3

    expect(canPromoteToMainline(alt.tree, alt.id)).toBe(true);
    const promoted = promoteToMainline(alt.tree, alt.id);

    expect(sans(promoted)).toEqual(["e4", "e5", "Bc4"]);
    expect(nodeAt(promoted, alt.id)!.mainline).toBe(true);
    expect(nodeAt(promoted, alt.id)!.depth).toBe(0);
    // Nf3 is now the side line, and knows it.
    const nf3 = [...promoted.nodes.values()].find((n) => n.san === "Nf3")!;
    expect(nf3.mainline).toBe(false);
    expect(nf3.depth).toBe(1);
  });
});

describe("immutability", () => {
  it("never edits the tree it was handed", () => {
    const t0 = fromMoves(RUY);
    const snapshot = t0.nodes.size;
    const forkChildren = [...nodeAt(t0, main(t0, 2))!.children];

    addMove(t0, main(t0, 2), "Nf6");
    deleteSubtree(t0, main(t0, 3));

    expect(t0.nodes.size).toBe(snapshot);
    expect(nodeAt(t0, main(t0, 2))!.children).toEqual(forkChildren);
  });
});
