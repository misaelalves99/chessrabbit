import { Chess, Square } from "chess.js";
import type { Classification, EvalLine } from "@/lib/api";
import { MoveTree, NodeId } from "@/lib/moveTree";

/**
 * Verdicts for the lines you try, from the evaluations already on the wire.
 *
 * A reviewed game gets its badges from the server: every position analysed in
 * one pass, classified, and stored. A line you invent during that review gets
 * nothing - there is no job behind it and never will be. But the board already
 * asks the engine about whatever position it is standing on, so walking a line
 * you played *is* an evaluation of every position in it. All that was missing
 * was somebody writing the answers down.
 *
 * This module is that arithmetic, and only that: given the score before a move
 * and the score after it, what would the review have called it? The rules are
 * deliberately the ones in services/engine/worker.py `_build_reviews` - same
 * win-percent curve, same thresholds, same treatment of mate - so a live badge
 * on a variation and a server badge on the game mean the same thing. If those
 * rules ever move, they have to move in both places; the tests below the
 * thresholds exist to make a silent divergence fail loudly.
 */

/** A forced mate, as a centipawn score. Mirrors the server's `_line_to_cp`. */
export const MATE_CP = 10000;

/** What the engine found in one position, always from White's point of view. */
export interface PositionEval {
  /** Centipawns, White-positive. A forced mate is folded to ±MATE_CP. */
  cp: number;
  /** Signed mate distance, White-positive, when the position is forced. */
  mate: number | null;
  /** The depth this score was reached at. 0 for a score given by rule. */
  depth: number;
  /** The engine's own first choice here, UCI. Absent on a rule-given score. */
  bestUci: string | null;
  /**
   * The line the engine expects from here, UCI. This is what turns a verdict
   * into an explanation: the first move of the opponent's reply is how you
   * find out that the piece you just moved is simply taken.
   */
  pv: string[];
  /** True when the game is already over in this position. */
  checkmate?: boolean;
}

/**
 * Fold a mate score into centipawns.
 *
 * The classifier works on one number, and a mate has to enter that scale
 * somewhere. ±10000 is far enough outside any real evaluation that a forced
 * mate always dominates, and it is the value the server picked - matching it
 * is what keeps the two sets of badges comparable.
 */
export function lineToCp(line: { cp: number | null; mate: number | null }): number {
  if (line.mate != null) return line.mate > 0 ? MATE_CP : -MATE_CP;
  return line.cp ?? 0;
}

/** Read one engine line into a position score, or null if it carries none. */
export function toPositionEval(line: EvalLine | undefined): PositionEval | null {
  if (!line) return null;
  if (line.cp == null && line.mate == null) return null;
  return {
    cp: lineToCp(line),
    mate: line.mate ?? null,
    depth: line.depth,
    bestUci: line.pv[0] ?? null,
    pv: line.pv ?? [],
  };
}

/**
 * Win expectancy for a centipawn score.
 *
 * Classifying on win percentage rather than raw centipawns is the whole reason
 * a review reads sensibly: dropping a pawn in a level position is a real
 * mistake, and dropping one when you are already eight ahead is not, though
 * both move the evaluation by the same 100 points.
 */
export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/**
 * Whether a position is already over is a fact about the position, so the
 * answer is worked out once and kept. Every move in the tree is checked on
 * every render of the move list, and re-parsing a FEN each time is the kind of
 * cost that only shows up on somebody else's laptop.
 */
const terminalCache = new Map<string, PositionEval | null>();
const TERMINAL_CACHE_MAX = 5000;

/**
 * Score a finished position by rule instead of asking the engine.
 *
 * Stockfish answers "mate 0" about a position that is already checkmate, which
 * carries no sign - and taking it at face value makes the move that delivered
 * mate look like the worst blunder in the game. The server sidesteps this by
 * scoring terminal positions itself before the engine ever sees them; a live
 * verdict has to do the same, because a mating line is exactly the kind of
 * thing you go looking for during a review.
 */
export function terminalEval(fen: string): PositionEval | null {
  const hit = terminalCache.get(fen);
  if (hit !== undefined) return hit;

  const result = computeTerminalEval(fen);
  if (terminalCache.size >= TERMINAL_CACHE_MAX) terminalCache.clear();
  terminalCache.set(fen, result);
  return result;
}

function computeTerminalEval(fen: string): PositionEval | null {
  let g: Chess;
  try {
    g = new Chess(fen);
  } catch {
    return null;
  }
  if (g.isCheckmate()) {
    // The side to move is the side that has been mated.
    return {
      cp: g.turn() === "w" ? -MATE_CP : MATE_CP,
      mate: null,
      depth: 0,
      bestUci: null,
      pv: [],
      checkmate: true,
    };
  }
  if (g.isStalemate() || g.isInsufficientMaterial()) {
    return { cp: 0, mate: null, depth: 0, bestUci: null, pv: [] };
  }
  return null;
}

/**
 * The verdict for a single move, by the rules the server review applies.
 *
 * Mate first, because delivering it is never a mistake however the numbers
 * read. Then the engine's own choice, which is "best" by definition. Only
 * after those does the win-percent drop decide, on the server's thresholds.
 *
 * There is one verdict the server can give that this cannot: "book". Opening
 * theory lives in a table on the server, and a line you invented is not in it.
 * A book move here comes back as "best" or "excellent", which is what it is.
 */
export function classifyMove(opts: {
  before: PositionEval;
  after: PositionEval;
  /** True when the move being judged was White's. */
  whiteMoved: boolean;
  playedUci: string;
}): Classification {
  const { before, after, whiteMoved, playedUci } = opts;

  if (after.checkmate) return "best";
  if (before.bestUci && before.bestUci === playedUci) return "best";

  const drop = Math.max(
    0,
    whiteMoved
      ? winPercent(before.cp) - winPercent(after.cp)
      : winPercent(after.cp) - winPercent(before.cp)
  );

  if (drop < 2) return "excellent";
  if (drop < 5) return "good";
  if (drop < 10) return "inaccuracy";
  if (drop < 20) return "mistake";
  return "blunder";
}

export interface LiveVerdict {
  cls: Classification;
  /** The score after the move, White-positive centipawns. */
  cp: number;
  /** The shallower of the two searches this verdict rests on. */
  depth: number;
}

/**
 * Judge every move in the tree we hold both ends of.
 *
 * A move needs the score before it and the score after it, so verdicts appear
 * in pairs as you walk a line rather than all at once - which is honest: a
 * move nobody has evaluated the far side of has not been judged, and showing
 * nothing is the correct amount to show.
 */
export function liveVerdicts(
  tree: MoveTree,
  evalAt: (fen: string) => PositionEval | null
): Map<NodeId, LiveVerdict> {
  const out = new Map<NodeId, LiveVerdict>();

  for (const node of tree.nodes.values()) {
    if (node.parent === null) continue;
    const parent = tree.nodes.get(node.parent);
    if (!parent) continue;

    const before = evalAt(parent.fen);
    const after = evalAt(node.fen);
    if (!before || !after) continue;

    out.set(node.id, {
      // Ply 0 is White's first move, so even plies are White's throughout.
      cls: classifyMove({
        before,
        after,
        whiteMoved: node.ply % 2 === 0,
        playedUci: node.uci,
      }),
      cp: after.cp,
      depth: Math.min(before.depth, after.depth),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Saying why
 * ------------------------------------------------------------------ */

const PIECE_NAME: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const OPENER: Partial<Record<Classification, string>> = {
  inaccuracy: "An inaccuracy.",
  mistake: "A mistake.",
  blunder: "A blunder.",
};

/** Mate distance if `ev` says the given side has a forced mate. */
function mateFor(ev: PositionEval, white: boolean): number | null {
  if (ev.mate == null) return null;
  return (ev.mate > 0) === white ? Math.abs(ev.mate) : null;
}

/** The first few moves of a UCI line, in the notation a player reads. */
export function sanLine(fen: string, pv: string[], limit = 5): string {
  let g: Chess;
  try {
    g = new Chess(fen);
  } catch {
    return "";
  }
  const out: string[] = [];
  for (const uci of pv.slice(0, limit)) {
    try {
      const mv = g.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
      if (!mv) break;
      out.push(mv.san);
    } catch {
      break;
    }
  }
  return out.join(" ");
}

/** The engine's preferred move here, in SAN. */
export function bestSanAt(fen: string, ev: PositionEval): string | null {
  return ev.bestUci ? sanLine(fen, [ev.bestUci]) || null : null;
}

/**
 * Say why a move earned its verdict, from engine facts only.
 *
 * A badge tells you a move was bad. It does not tell you what you missed,
 * which is the only part that makes you better at this. The server writes that
 * sentence for the game it reviewed; this writes the same sentence for a line
 * you invented, from the same evidence and in the same order of preference:
 *
 *   a mate you had, a mate you allowed, a stalemate you walked into, a piece
 *   you left hanging - and only if none of those, the bare swing in the score.
 *
 * Nothing here speculates. Every clause is something the engine's own lines
 * assert, which is why "en prise" is only ever claimed when the opponent's
 * best reply is literally the capture of the piece that just moved.
 */
export function explainMove(opts: {
  cls: Classification;
  before: PositionEval;
  after: PositionEval;
  /** The position the move was played from. */
  beforeFen: string;
  /** The position it produced. */
  afterFen: string;
  playedUci: string;
  /** True when the move being explained was White's. */
  whiteMoved: boolean;
}): string {
  const { cls, before, after, beforeFen, afterFen, playedUci, whiteMoved } = opts;

  if (after.checkmate) return "Checkmate.";

  if (cls === "best") {
    const kept = mateFor(after, whiteMoved);
    return kept != null
      ? `Best move — keeps the forced mate in ${kept} on track.`
      : "Best move — the engine's top choice.";
  }
  if (cls === "excellent") {
    return "Excellent — practically as strong as the engine's first choice.";
  }
  if (cls === "good") return "A solid move.";
  if (cls === "book") return "Book move — established opening theory.";

  // What follows is only for the three verdicts that owe an explanation.
  const bestSan = bestSanAt(beforeFen, before);
  const line = sanLine(beforeFen, before.pv);

  const missedMate = mateFor(before, whiteMoved);
  const allowedMate = mateFor(after, !whiteMoved);
  const hadMateAgainst = mateFor(before, !whiteMoved); // already lost before the move

  let cause: string | null = null;

  if (missedMate != null && mateFor(after, whiteMoved) == null) {
    cause =
      `There was a forced mate in ${missedMate}` +
      (bestSan ? ` starting with ${bestSan}.` : ".");
  } else if (allowedMate != null && hadMateAgainst == null) {
    cause = `This allows a forced mate in ${allowedMate}.`;
  } else if (isStalemate(afterFen)) {
    cause = "Stalemate — the game is drawn despite the material.";
  } else if (cls !== "inaccuracy" && after.pv.length) {
    // Hanging piece: the opponent's best reply simply captures what just moved.
    const reply = after.pv[0];
    if (reply.slice(2, 4) === playedUci.slice(2, 4)) {
      try {
        const g = new Chess(afterFen);
        const victim = g.get(reply.slice(2, 4) as Square);
        const mv = g.move({
          from: reply.slice(0, 2),
          to: reply.slice(2, 4),
          promotion: reply[4] || undefined,
        });
        if (victim && mv) {
          cause =
            `This leaves the ${PIECE_NAME[victim.type] ?? "piece"} on ` +
            `${reply.slice(2, 4)} en prise — ${mv.san} wins material.`;
        }
      } catch {
        /* the reply did not replay; fall through to the score */
      }
    }
  }

  if (cause == null) {
    const bothNormal = Math.abs(before.cp) < 2000 && Math.abs(after.cp) < 2000;
    cause = bothNormal
      ? `The evaluation swings by ${(Math.abs(before.cp - after.cp) / 100).toFixed(1)} pawns.`
      : "The advantage slips away.";
  }

  const suggestion = bestSan
    ? ` Better was ${bestSan}` + (line && line.includes(" ") ? ` (${line}).` : ".")
    : "";

  return `${OPENER[cls] ?? ""} ${cause}${suggestion}`.trim();
}

function isStalemate(fen: string): boolean {
  try {
    return new Chess(fen).isStalemate();
  } catch {
    return false;
  }
}

/** Format a White-positive centipawn score the way the eval bar does. */
export function formatCp(cp: number): string {
  if (Math.abs(cp) >= MATE_CP) return cp > 0 ? "+M" : "-M";
  const pawns = cp / 100;
  return (pawns >= 0 ? "+" : "") + pawns.toFixed(2);
}
