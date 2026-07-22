import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Chess, Square } from "chess.js";

/**
 * Click-to-move + legal-move highlighting for a react-chessboard.
 *
 * Click a piece to select it: every legal destination is dotted (a ring for
 * captures), and clicking one of them plays the move. Clicking the piece again
 * (or an empty square) clears the selection. Drag-and-drop keeps working - this
 * only adds a click path on top of it.
 *
 * `onMove` is the same handler used for onPieceDrop: (from, to) => moved?.
 * Pass `enabled: false` to disable selection (e.g. while a solution animates).
 * Returns `squareStyles` to merge into the board's `customSquareStyles`.
 */
export function useClickToMove(
  fen: string,
  onMove: (from: string, to: string) => boolean,
  enabled = true,
) {
  const [selected, setSelected] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, boolean>>({}); // square -> isCapture

  const clearSelection = useCallback(() => {
    setSelected(null);
    setTargets({});
  }, []);

  // A new position (move made, board navigation) or a disable cancels selection.
  useEffect(() => {
    clearSelection();
  }, [fen, enabled, clearSelection]);

  const select = useCallback(
    (square: string): boolean => {
      const g = new Chess(fen);
      const piece = g.get(square as Square);
      if (!piece || piece.color !== g.turn()) return false;
      const moves = g.moves({ square: square as Square, verbose: true });
      if (moves.length === 0) return false;
      const found: Record<string, boolean> = {};
      for (const m of moves) {
        found[m.to] = m.flags.includes("c") || m.flags.includes("e"); // capture / en passant
      }
      setSelected(square);
      setTargets(found);
      return true;
    },
    [fen],
  );

  const onSquareClick = useCallback(
    (square: string) => {
      if (!enabled) return;
      // A legal destination for the selected piece -> play it.
      if (selected && square in targets) {
        onMove(selected, square);
        clearSelection();
        return;
      }
      // Re-clicking the selected piece deselects it.
      if (selected === square) {
        clearSelection();
        return;
      }
      // Otherwise (re)select if this square holds a side-to-move piece.
      if (!select(square)) clearSelection();
    },
    [enabled, selected, targets, onMove, select, clearSelection],
  );

  const squareStyles = useMemo(() => {
    if (!enabled) return {} as Record<string, CSSProperties>;
    const styles: Record<string, CSSProperties> = {};
    if (selected) {
      styles[selected] = { background: "rgba(255, 241, 120, 0.5)" };
    }
    for (const [square, isCapture] of Object.entries(targets)) {
      styles[square] = isCapture
        ? {
            // ring hugging the square edges
            background:
              "radial-gradient(circle, rgba(0,0,0,0) 74%, rgba(0,0,0,0.28) 75%, rgba(0,0,0,0.28) 84%, rgba(0,0,0,0) 85%)",
          }
        : {
            // centered dot
            background:
              "radial-gradient(circle, rgba(0,0,0,0.26) 19%, rgba(0,0,0,0) 21%)",
          };
    }
    return styles;
  }, [enabled, selected, targets]);

  return { onSquareClick, squareStyles, clearSelection };
}
