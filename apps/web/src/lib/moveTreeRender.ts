import { MoveTree, MoveNode, NodeId, mainlinePath } from "@/lib/moveTree";

/**
 * Flattens a move tree into rows a component can render without thinking.
 *
 * The numbering rules for chess notation are fiddly enough - when a move gets
 * a number, when it gets "12..." instead of "12.", where a side line is
 * allowed to sit inside the line it came from - that discovering them inside
 * JSX guarantees getting them subtly wrong. All of it lives here, as a pure
 * function over the tree, so it can be checked against fixtures.
 */

export type Token =
  | { t: "move"; id: NodeId; san: string; num?: string }
  | { t: "paren"; text: "(" | ")" };

export interface PairRow {
  kind: "pair";
  key: string;
  moveNo: number;
  white?: NodeId;
  black?: NodeId;
}

export interface VariationRow {
  kind: "variation";
  key: string;
  /** 1 for a side line off the game, 2 for one inside that, and so on. */
  depth: number;
  /** The first move of this line - what the row is identified by. */
  anchor: NodeId;
  tokens: Token[];
}

export type Row = PairRow | VariationRow;

/**
 * A side line short enough, and straight enough, to sit inside the line it
 * branches from rather than take a row of its own. Keeping a two-move
 * refutation next to the move it refutes is worth a lot in a 352px panel;
 * doing it to a line that itself branches is how a move list becomes soup.
 */
const INLINE_MAX_PLIES = 4;

function inlineable(tree: MoveTree, id: NodeId): boolean {
  let n = tree.nodes.get(id);
  let plies = 0;
  while (n) {
    if (n.children.length > 1) return false;
    if (++plies > INLINE_MAX_PLIES) return false;
    n = n.children.length ? tree.nodes.get(n.children[0]) : undefined;
  }
  return true;
}

export function moveNumber(node: MoveNode): number {
  return Math.floor(node.ply / 2) + 1;
}

/**
 * White's moves always carry their number. Black's carry "12..." only when
 * nothing precedes them to make the position obvious - the start of a line,
 * or the first move after a bracket closed.
 */
function label(node: MoveNode, forced: boolean): string | undefined {
  const white = node.ply % 2 === 0;
  if (white) return `${moveNumber(node)}.`;
  return forced ? `${moveNumber(node)}...` : undefined;
}

/** The moves that were available instead of `node`. */
function alternativesTo(tree: MoveTree, node: MoveNode): NodeId[] {
  if (node.parent === null) return [];
  const parent = tree.nodes.get(node.parent);
  return parent ? parent.children.filter((c) => c !== node.id) : [];
}

function inlineTokens(tree: MoveTree, id: NodeId): Token[] {
  const out: Token[] = [];
  let cur: NodeId | undefined = id;
  let forced = true;
  while (cur !== undefined) {
    const n = tree.nodes.get(cur);
    if (!n) break;
    out.push({ t: "move", id: n.id, san: n.san, num: label(n, forced) });
    forced = false;
    cur = n.children[0];
  }
  return out;
}

/**
 * Walk one side line into a row, pushing the lines that branch off it - the
 * ones too long to inline - as further rows underneath.
 */
function emitVariation(tree: MoveTree, start: NodeId, depth: number, out: Row[]): void {
  const tokens: Token[] = [];
  const deferred: NodeId[] = [];
  let cur: NodeId | undefined = start;
  let forced = true;

  // An alternative belongs after the move it replaces, and a node only learns
  // about its own alternatives from its parent - so they trail by one step.
  let pending: NodeId[] = [];

  while (cur !== undefined) {
    const n = tree.nodes.get(cur);
    if (!n) break;
    tokens.push({ t: "move", id: n.id, san: n.san, num: label(n, forced) });
    forced = false;

    for (const alt of pending) {
      if (inlineable(tree, alt)) {
        tokens.push({ t: "paren", text: "(" }, ...inlineTokens(tree, alt), { t: "paren", text: ")" });
        forced = true; // a bracket resets the reader: number the next move
      } else {
        deferred.push(alt);
      }
    }

    pending = n.children.slice(1);
    cur = n.children[0];
  }
  for (const alt of pending) deferred.push(alt);

  out.push({ kind: "variation", key: `v${start}`, depth, anchor: start, tokens });
  for (const alt of deferred) emitVariation(tree, alt, depth + 1, out);
}

/**
 * The whole move list: the game in numbered pairs, with every line you tried
 * instead of it indented beneath the move it answers.
 */
export function renderTree(tree: MoveTree): Row[] {
  const main = mainlinePath(tree);
  const rows: Row[] = [];

  for (let i = 0; i < main.length; i += 2) {
    const white = main[i];
    const black = main[i + 1];
    rows.push({
      kind: "pair",
      key: `p${white.id}`,
      moveNo: moveNumber(white),
      white: white.id,
      black: black?.id,
    });
    // Both halves of the row may have been questioned; White's answers first.
    for (const node of black ? [white, black] : [white]) {
      for (const alt of alternativesTo(tree, node)) emitVariation(tree, alt, 1, rows);
    }
  }

  // Anything played on from the final position - including a locked game's
  // "what if it had gone on" - hangs off the end rather than extending it.
  const tail = main.length ? main[main.length - 1] : tree.nodes.get(tree.root);
  for (const alt of tail?.children ?? []) {
    if (!tree.nodes.get(alt)?.mainline) emitVariation(tree, alt, 1, rows);
  }

  return rows;
}
