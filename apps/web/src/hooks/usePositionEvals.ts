"use client";

import { useCallback, useState } from "react";
import type { EvalLine } from "@/lib/api";
import { PositionEval, terminalEval, toPositionEval } from "@/lib/liveEval";

/**
 * Everything the engine has told us this session, keyed by position.
 *
 * The board already asks the engine about whatever position it is standing on.
 * Without somewhere to put the answers, walking a line evaluates every position
 * in it and then discards all of them - which is why a line you tried used to
 * come back with no verdicts on it. This is that somewhere.
 *
 * Keyed by FEN rather than by node, deliberately: two lines that transpose are
 * the same position and deserve the same score, and a position keeps its score
 * when the line leading to it is deleted and played again.
 */

/** Positions kept before the oldest start falling off. Scores are small; the
    cap exists so a long session cannot grow this without bound. */
const MAX_POSITIONS = 2000;

export interface PositionEvalStore {
  /** The best score we hold for a position, or null if it has none yet. */
  evalAt: (fen: string) => PositionEval | null;
  /** File what the engine found. Ignored if it is shallower than what we hold. */
  record: (fen: string, line: EvalLine | undefined) => void;
}

export function usePositionEvals(): PositionEvalStore {
  const [found, setFound] = useState<ReadonlyMap<string, PositionEval>>(() => new Map());

  const record = useCallback((fen: string, line: EvalLine | undefined) => {
    const next = toPositionEval(line);
    if (!next) return;

    setFound((prev) => {
      const have = prev.get(fen);
      // A search reports at every depth on its way down. Only a deeper answer
      // is news; treating the rest as news would rebuild the map, and every
      // verdict derived from it, twenty times per position.
      if (have && have.depth >= next.depth) return prev;

      const m = new Map(prev);
      if (m.size >= MAX_POSITIONS) m.clear();
      m.set(fen, next);
      return m;
    });
  }, []);

  const evalAt = useCallback(
    // A finished game outranks anything the engine says about it.
    (fen: string): PositionEval | null => terminalEval(fen) ?? found.get(fen) ?? null,
    [found]
  );

  return { evalAt, record };
}
