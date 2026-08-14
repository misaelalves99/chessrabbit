import { beforeEach, describe, expect, it } from "vitest";
import {
  addLine,
  addMove,
  annotate,
  deleteSubtree,
  fromMoves,
  mainlinePath,
  nodeAt,
  type MoveTree,
  type NodeId,
} from "@/lib/moveTree";
import { deserializeTree, loadTree, saveTree, serializeTree } from "@/lib/treeStorage";

const RUY = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];
const main = (t: MoveTree, n: number): NodeId => mainlinePath(t)[n].id;

/** Just enough of the Storage interface for the code under test. */
class MemStorage {
  map = new Map<string, string>();
  full = false;
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.full) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

let ls: MemStorage;

beforeEach(() => {
  ls = new MemStorage();
  (globalThis as unknown as { window: unknown }).window = { localStorage: ls };
});

/** A game with two questions at move 2 and a line inside one of them. */
function explored() {
  const t0 = fromMoves(RUY);
  const a = addLine(t0, main(t0, 2), ["Nf6", "Nxe5", "d6"], { source: "engine", evalCp: 42 });
  const b = addMove(a.tree, main(t0, 2), "d6");
  const c = addLine(b.tree, a.id, ["d3", "Bc5"]);
  return { tree: annotate(c.tree, a.id, { comment: "the fork", nag: 5 }), cursor: a.id };
}

describe("serializing", () => {
  it("rebuilds the same tree, ids and all", () => {
    const { tree, cursor } = explored();
    const back = deserializeTree(serializeTree(tree, cursor));

    expect(back.tree.nodes.size).toBe(tree.nodes.size);
    expect(back.cursorId).toBe(cursor);
    expect(mainlinePath(back.tree).map((n) => n.san)).toEqual(RUY);
    expect(back.tree.locked).toBe(true);

    for (const [id, n] of tree.nodes) {
      const r = nodeAt(back.tree, id)!;
      expect([r.san, r.parent, r.children, r.mainline, r.depth, r.fen]).toEqual([
        n.san,
        n.parent,
        n.children,
        n.mainline,
        n.depth,
        n.fen,
      ]);
    }
  });

  it("keeps what a person put there, and recomputes the rest", () => {
    const { tree, cursor } = explored();
    const back = deserializeTree(serializeTree(tree, cursor)).tree;
    const head = nodeAt(back, cursor)!;

    expect(head.comment).toBe("the fork");
    expect(head.nag).toBe(5);
    expect(head.source).toBe("engine");
    expect(head.evalCp).toBe(42);
    // Derived fields were never written, so these prove they were rebuilt.
    expect(head.ply).toBe(3);
    expect(head.depth).toBe(1);
  });

  it("survives ids left with holes in them", () => {
    const { tree, cursor } = explored();
    const pruned = deleteSubtree(tree, mainlinePath(tree)[2].children[2]); // the d6 line
    const back = deserializeTree(serializeTree(pruned.tree, cursor));

    expect(back.tree.nodes.size).toBe(pruned.tree.nodes.size);
    expect(mainlinePath(back.tree).map((n) => n.san)).toEqual(RUY);
  });

  it("writes nothing derivable", () => {
    const { tree, cursor } = explored();
    const json = JSON.stringify(serializeTree(tree, cursor));
    expect(json).not.toContain("rnbqkbnr"); // no FENs
    expect(json).not.toContain("mainline");
    expect(json).not.toContain("depth");
  });
});

describe("storing", () => {
  it("brings an explored game back", () => {
    const { tree, cursor } = explored();
    saveTree("game:7", tree, cursor);

    const back = loadTree("game:7", RUY);
    expect(back).not.toBeNull();
    expect(back!.cursorId).toBe(cursor);
    expect(back!.tree.nodes.size).toBe(tree.nodes.size);
  });

  it("refuses a tree whose main line is no longer this game", () => {
    const { tree, cursor } = explored();
    saveTree("game:7", tree, cursor);

    expect(loadTree("game:7", ["d4", "d5"])).toBeNull();
    expect(loadTree("game:7", RUY.slice(0, 4))).toBeNull();
    // A refused entry is dropped, not left to be refused again.
    expect(loadTree("game:7", RUY)).toBeNull();
  });

  it("does not clutter storage with games nobody explored", () => {
    saveTree("game:8", fromMoves(RUY), 0);
    expect(loadTree("game:8", RUY)).toBeNull();
    expect(ls.map.size).toBe(0);
  });

  it("forgets a game once its lines are deleted", () => {
    const { tree, cursor } = explored();
    saveTree("game:9", tree, cursor);
    expect(ls.getItem("chessrabbit.tree.game:9")).toBeTruthy();

    saveTree("game:9", fromMoves(RUY), 0);
    expect(ls.getItem("chessrabbit.tree.game:9")).toBeNull();
  });

  it("evicts the games explored longest ago", () => {
    const { tree, cursor } = explored();
    for (let i = 0; i < 35; i++) saveTree(`game:${i}`, tree, cursor);

    expect(loadTree("game:0", RUY)).toBeNull(); // pushed out
    expect(loadTree("game:34", RUY)).not.toBeNull();
  });

  it("shrugs off a full disk and a corrupt entry", () => {
    const { tree, cursor } = explored();
    ls.full = true;
    expect(() => saveTree("game:10", tree, cursor)).not.toThrow();

    ls.full = false;
    ls.map.set("chessrabbit.tree.game:11", "{ not json");
    expect(loadTree("game:11", RUY)).toBeNull();
  });

  it("does nothing at all when there is no window to store in", () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    const { tree, cursor } = explored();
    expect(() => saveTree("game:12", tree, cursor)).not.toThrow();
    expect(loadTree("game:12", RUY)).toBeNull();
  });

  /**
   * A game you only wrote on - notes, marks, arrows drawn over the moves that
   * were played - has no extra nodes at all, and counting nodes threw every
   * bit of it away on reload.
   */
  it("keeps a game annotated but never branched", () => {
    const tree = annotate(fromMoves(RUY), main(fromMoves(RUY), 2), {
      comment: "the point [%cal Gf1b5]",
    });
    saveTree("game:13", tree, 0);

    const back = loadTree("game:13", RUY);
    expect(back).not.toBeNull();
    expect(nodeAt(back!.tree, main(back!.tree, 2))!.comment).toBe("the point [%cal Gf1b5]");
  });

  it("keeps a mark with no words behind it", () => {
    const tree = annotate(fromMoves(RUY), main(fromMoves(RUY), 4), { nag: 1 });
    saveTree("game:14", tree, 0);
    expect(nodeAt(loadTree("game:14", RUY)!.tree, main(fromMoves(RUY), 4))!.nag).toBe(1);
  });

  // Shapes on the opening position have no move to hang off, so they need
  // their own place in the stored form or they are silently dropped.
  it("keeps what was written about the starting position", () => {
    const tree = annotate(fromMoves(RUY), 0, { comment: "[%csl Ge4]" });
    saveTree("game:15", tree, 0);

    const back = loadTree("game:15", RUY);
    expect(nodeAt(back!.tree, back!.tree.root)!.comment).toBe("[%csl Ge4]");
  });

  it("still forgets a game with nothing written on it and nothing tried", () => {
    saveTree("game:16", fromMoves(RUY), 0);
    expect(ls.getItem("chessrabbit.tree.game:16")).toBeNull();
  });
});
