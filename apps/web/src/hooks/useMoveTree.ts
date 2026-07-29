"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, Square } from "chess.js";
import {
  MoveNode,
  MoveSource,
  MoveTree,
  NodeId,
  ROOT,
  addLine,
  addMove,
  deleteSubtree,
  endOfLine,
  mainlinePath,
  nearestMainline,
  nodeAt,
  promoteSibling,
  siblingBy,
  startOfLine,
} from "@/lib/moveTree";
import { Row, renderTree } from "@/lib/moveTreeRender";
import { parsePgn, toPgn } from "@/lib/pgn";
import { loadTree, saveTree } from "@/lib/treeStorage";

/**
 * The move tree as the workspace uses it: state, navigation, and the handful
 * of derived values the rest of the board still wants in the old shape.
 *
 * `history` and `cursorPly` are the bridge. The review was built against a
 * flat list of the game's moves keyed by ply, and it stays that way - the main
 * line IS that list, so `ReviewPanel`, the annotation alignment check and the
 * eval curve keep receiving exactly what they received before the tree
 * existed, and none of them need to know it does.
 */
export interface MoveTreeApi {
  tree: MoveTree;
  rows: Row[];
  cursorId: NodeId;
  node: MoveNode;
  fen: string;

  /** The game's moves, in order. What the review is keyed against. */
  history: string[];
  /** Each main-line move's UCI, indexed by ply - for checking review rows. */
  mainUci: string[];
  /** True when the cursor is on the game rather than off in a side line. */
  onMainline: boolean;
  /** The old cursor: 0 at the start, N after N moves. -1 when off the game. */
  cursorPly: number;
  /** The move that led to the current position. */
  lastMove?: { from: Square; to: Square };
  /** Alternatives to the current move, the current one among them. */
  alternatives: NodeId[];

  seek: (id: NodeId) => void;
  seekPly: (ply: number) => void;
  play: (from: string, to: string) => boolean;
  /** Play a line on from here - what an engine PV for this position is. */
  playLine: (sans: string[], opts?: { source?: MoveSource; evalCp?: number | null }) => void;
  /** Play a line *instead of* the move you are looking at. What "best was X" means. */
  playInstead: (sans: string[], opts?: { source?: MoveSource; evalCp?: number | null }) => void;

  back: () => void;
  next: () => void;
  toStart: () => void;
  toEnd: () => void;
  nextAlternative: (step: number) => void;
  backToGame: () => void;
  removeLine: () => void;
  raiseLine: () => void;
  /** The game and every line off it, as PGN anything else can read. */
  exportPgn: (headers?: Record<string, string>) => string;
}

/** Long enough that walking a line does not write once per move. */
const SAVE_AFTER_MS = 600;

export function useMoveTree(initialPgn?: string, storageKey?: string): MoveTreeApi {
  const [tree, setTree] = useState<MoveTree>(() => parsePgn(initialPgn ?? "").tree);
  const [cursorId, setCursorId] = useState<NodeId>(ROOT);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  // Nothing may be written back before the saved lines have had their chance
  // to load, or the first render would overwrite them with the bare game.
  const hydrated = useRef(false);

  useEffect(() => {
    const parsed = parsePgn(initialPgn ?? "");
    const saved = storageKey
      ? loadTree(storageKey, mainlinePath(parsed.tree).map((n) => n.san))
      : null;

    setHeaders(parsed.headers);
    setTree(saved?.tree ?? parsed.tree);
    setCursorId(saved?.cursorId ?? ROOT);
    hydrated.current = true;
  }, [initialPgn, storageKey]);

  useEffect(() => {
    if (!storageKey || !hydrated.current) return;
    const timer = setTimeout(() => saveTree(storageKey, tree, cursorId), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [storageKey, tree, cursorId]);

  const main = useMemo(() => mainlinePath(tree), [tree]);
  const rows = useMemo(() => renderTree(tree), [tree]);

  const node = nodeAt(tree, cursorId) ?? nodeAt(tree, tree.root)!;
  const onMainline = node.mainline;

  const lastMove = node.uci
    ? { from: node.uci.slice(0, 2) as Square, to: node.uci.slice(2, 4) as Square }
    : undefined;

  const alternatives = useMemo(() => {
    if (node.parent === null) return [];
    return nodeAt(tree, node.parent)?.children ?? [];
  }, [tree, node]);

  const seek = useCallback((id: NodeId) => setCursorId(id), []);

  /** Ply 0 is the start position; ply k is after the game's kth move. */
  const seekPly = useCallback(
    (ply: number) => setCursorId(ply <= 0 ? ROOT : (main[ply - 1]?.id ?? ROOT)),
    [main]
  );

  const play = useCallback(
    (from: string, to: string) => {
      const g = new Chess(node.fen);
      let mv;
      try {
        mv = g.move({ from, to, promotion: "q" });
      } catch {
        return false;
      }
      if (!mv) return false;
      const r = addMove(tree, node.id, mv.san, { source: "user" });
      setTree(r.tree);
      setCursorId(r.id);
      return true;
    },
    [tree, node]
  );

  const playLine = useCallback(
    (sans: string[], opts: { source?: MoveSource; evalCp?: number | null } = {}) => {
      const r = addLine(tree, node.id, sans, { source: "engine", ...opts });
      setTree(r.tree);
      setCursorId(r.id);
    },
    [tree, node]
  );

  // The move the engine wanted is a rival to the move you played, so it hangs
  // off the position *before* it - alongside what actually happened, not after.
  const playInstead = useCallback(
    (sans: string[], opts: { source?: MoveSource; evalCp?: number | null } = {}) => {
      const r = addLine(tree, node.parent ?? ROOT, sans, { source: "engine", ...opts });
      setTree(r.tree);
      setCursorId(r.id);
    },
    [tree, node]
  );

  const back = useCallback(() => setCursorId(node.parent ?? ROOT), [node]);

  // Forward continues the line you are standing in, not the game. Inside a
  // variation that is the only thing that makes it walkable.
  const next = useCallback(() => {
    if (node.children.length) setCursorId(node.children[0]);
  }, [node]);

  const toStart = useCallback(() => {
    // From within a side line, the first stop is that line's own beginning.
    const head = startOfLine(tree, cursorId);
    setCursorId(head === cursorId || cursorId === ROOT ? ROOT : head);
  }, [tree, cursorId]);

  const toEnd = useCallback(() => setCursorId(endOfLine(tree, cursorId)), [tree, cursorId]);

  const nextAlternative = useCallback(
    (step: number) => setCursorId((id) => siblingBy(tree, id, step)),
    [tree]
  );

  const backToGame = useCallback(
    () => setCursorId(nearestMainline(tree, cursorId)),
    [tree, cursorId]
  );

  const removeLine = useCallback(() => {
    const r = deleteSubtree(tree, cursorId);
    setTree(r.tree);
    setCursorId(r.id);
  }, [tree, cursorId]);

  const raiseLine = useCallback(() => setTree(promoteSibling(tree, cursorId)), [tree, cursorId]);

  return {
    tree,
    rows,
    cursorId,
    node,
    fen: node.fen,
    history: useMemo(() => main.map((n) => n.san), [main]),
    mainUci: useMemo(() => main.map((n) => n.uci), [main]),
    onMainline,
    cursorPly: onMainline ? node.ply + 1 : -1,
    lastMove,
    alternatives,
    seek,
    seekPly,
    play,
    playLine,
    playInstead,
    back,
    next,
    toStart,
    toEnd,
    nextAlternative,
    backToGame,
    removeLine,
    raiseLine,
    exportPgn: useCallback(
      (extra: Record<string, string> = {}) => toPgn(tree, { ...headers, ...extra }),
      [tree, headers]
    ),
  };
}
