import {
  MoveTree,
  NodeId,
  ROOT,
  addMove,
  annotate,
  createTree,
  mainlinePath,
} from "@/lib/moveTree";

/**
 * PGN movetext with variations, in both directions.
 *
 * chess.js is the only chess code allowed in the browser, and it reads and
 * writes the main line only - `( )` blocks are dropped silently on the way in
 * and never emitted on the way out, along with NAGs:
 *
 *   in   1. e4 e5 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 {said so} 3. Bb5 $1 a6
 *   out  1. e4 e5 2. Nf3 Nc6 {said so} 3. Bb5 a6
 *
 * Which is exactly the half of the format a move tree is about. So the reading
 * and writing of branches lives here, over chess.js's move generation rather
 * than its parser. It is the same walk `prep.py` does server-side when it turns
 * a repertoire PGN into position cards, so the two agree on what a variation
 * means.
 */

/** Suffix annotations, and the NAG each one stands for. */
const NAG_FOR_SUFFIX: Record<string, number> = {
  "!": 1,
  "?": 2,
  "!!": 3,
  "??": 4,
  "!?": 5,
  "?!": 6,
};
const SUFFIX_FOR_NAG: Record<number, string> = {
  1: "!",
  2: "?",
  3: "!!",
  4: "??",
  5: "!?",
  6: "?!",
};

/**
 * One movetext token: a comment, a NAG, a bracket, a move number, a result, or
 * a move. Move numbers and results are read and thrown away - the tree derives
 * numbering from ply, and the result belongs to the headers.
 */
const TOKEN =
  /\{[^}]*\}|;[^\r\n]*|\$\d+|[()]|\d+\.{1,3}|1-0|0-1|1\/2-1\/2|\*|[OKQRBNa-h][^\s(){}$;]*/g;

const HEADER = /^\s*\[\s*(\w+)\s*"([^"]*)"\s*\]\s*$/gm;

export interface ParsedPgn {
  tree: MoveTree;
  headers: Record<string, string>;
}

export function parsePgn(pgn: string): ParsedPgn {
  const headers: Record<string, string> = {};
  for (const m of pgn.matchAll(HEADER)) headers[m[1]] = m[2];
  const movetext = pgn.replace(HEADER, "");

  let tree = createTree();
  let cur: NodeId = ROOT;
  // Where to come back to when each open bracket closes.
  const stack: NodeId[] = [];
  // A line whose moves stopped making sense: skipped until its bracket closes,
  // so one bad move costs that variation rather than the rest of the file.
  let deadAt: number | null = null;

  for (const match of movetext.matchAll(TOKEN)) {
    const tok = match[0];
    const head = tok[0];

    // A bracket opens a rival to the move just played, so it hangs off that
    // move's parent - which is also why an unplayed position cannot have one.
    if (head === "(") {
      stack.push(cur);
      if (deadAt === null) {
        const parent = tree.nodes.get(cur)?.parent;
        if (parent == null) deadAt = stack.length;
        else cur = parent;
      }
      continue;
    }
    if (head === ")") {
      const back = stack.pop();
      if (back !== undefined) cur = back;
      if (deadAt !== null && stack.length < deadAt) deadAt = null;
      continue;
    }
    if (deadAt !== null) continue;

    if (head === "{") {
      if (cur !== ROOT) tree = annotate(tree, cur, { comment: tok.slice(1, -1).trim() });
      continue;
    }
    if (head === "$") {
      if (cur !== ROOT) tree = annotate(tree, cur, { nag: parseInt(tok.slice(1), 10) });
      continue;
    }
    // Move numbers, results and `;` remarks carry nothing the tree needs.
    if (head === ";" || head === "*" || (head >= "0" && head <= "9")) continue;

    const suffix = /[!?]{1,2}$/.exec(tok)?.[0];
    const san = suffix ? tok.slice(0, -suffix.length) : tok;

    // Inside a bracket is by definition not the game, whatever the file says.
    const r = addMove(tree, cur, san, { source: stack.length === 0 ? "game" : "user" });
    if (r.id === cur) {
      deadAt = stack.length;
      continue;
    }
    tree = r.tree;
    cur = r.id;
    if (suffix) tree = annotate(tree, cur, { nag: NAG_FOR_SUFFIX[suffix] });
  }

  // Only an actual game locks its main line. An empty PGN is a blank board,
  // and a blank board is something you are still allowed to build a game on.
  return { tree: { ...tree, locked: mainlinePath(tree).length > 0 }, headers };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

const SEVEN_TAG: Record<string, string> = {
  Event: "?",
  Site: "?",
  Date: "????.??.??",
  Round: "?",
  White: "?",
  Black: "?",
  Result: "*",
};

/** How wide a movetext line gets before it wraps, as the spec suggests. */
const WRAP = 80;

export function toPgn(tree: MoveTree, headers: Record<string, string> = {}): string {
  const tags = { ...SEVEN_TAG, ...headers };
  const head = Object.entries(tags)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join("\n");

  const first = tree.nodes.get(tree.root)?.children[0];
  const body = first === undefined ? [] : lineText(tree, first, true);
  return `${head}\n\n${wrap([...body, tags.Result])}\n`;
}

/**
 * One line of play, with each rival to a move written in brackets straight
 * after it - the placement the format requires and every reader assumes.
 */
function lineText(tree: MoveTree, first: NodeId, forced: boolean): string[] {
  const out: string[] = [];
  let cur: NodeId | undefined = first;
  let needNum = forced;

  while (cur !== undefined) {
    const n = tree.nodes.get(cur);
    if (!n) break;
    out.push(number(n.ply, needNum) + n.san + (SUFFIX_FOR_NAG[n.nag ?? 0] ?? ""));
    needNum = false;

    if (n.comment) {
      out.push(`{${n.comment}}`);
      needNum = true; // a comment breaks the reader's place; renumber after it
    }

    // Only the continuation carries its position's alternatives. A variation
    // head is written by whoever opened its bracket.
    const parent = n.parent === null ? undefined : tree.nodes.get(n.parent);
    if (parent && parent.children[0] === n.id) {
      for (const alt of parent.children.slice(1)) {
        out.push(`(${lineText(tree, alt, true).join(" ")})`);
        needNum = true;
      }
    }
    cur = n.children[0];
  }
  return out;
}

function number(ply: number, forced: boolean): string {
  const no = Math.floor(ply / 2) + 1;
  if (ply % 2 === 0) return `${no}. `;
  return forced ? `${no}... ` : "";
}

function wrap(tokens: string[]): string {
  const lines: string[] = [];
  let line = "";
  for (const t of tokens) {
    if (line && line.length + t.length + 1 > WRAP) {
      lines.push(line);
      line = t;
    } else {
      line = line ? `${line} ${t}` : t;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
