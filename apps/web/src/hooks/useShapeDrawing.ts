"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Shape, brushFor, toggleShape } from "@/lib/shapes";

/**
 * Drawing arrows and circles on the board with the right mouse button.
 *
 * The press is caught on the board's *wrapper*, not on a layer above it. An
 * overlay that could receive a click would have to sit over the squares, and
 * then every square it covers stops being playable - so instead the wrapper
 * watches for the right button, which nothing else on the board uses, and the
 * left button passes through to the pieces untouched.
 *
 * Everything after the press is bound to the window rather than the board. A
 * drag that ends past the edge is the common case, not the exception, and a
 * release the board never hears about would leave the gesture live until the
 * next press - drawing an arrow from wherever the last one was abandoned.
 *
 * The gestures are the ones every board has: right-click a square for a ring,
 * right-drag between two for an arrow, and repeat either to take it off.
 * Shift, Alt and Ctrl choose the colour (see `brushFor`).
 */

interface Options {
  orientation: "white" | "black";
  shapes: Shape[];
  onChange: (shapes: Shape[]) => void;
  /** Reading somebody else's study: the gestures do nothing at all. */
  disabled?: boolean;
}

/** Which square a point on the board is over, or null past its edge. */
function squareAt(
  el: HTMLElement,
  clientX: number,
  clientY: number,
  orientation: "white" | "black"
): string | null {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const col = Math.floor(((clientX - rect.left) / rect.width) * 8);
  const row = Math.floor(((clientY - rect.top) / rect.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;

  const file = orientation === "white" ? col : 7 - col;
  const rank = orientation === "white" ? 8 - row : row + 1;
  return String.fromCharCode(97 + file) + rank;
}

export function useShapeDrawing({ orientation, shapes, onChange, disabled }: Options) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  /** The square the button went down on. State, so the drag effect can start. */
  const [from, setFrom] = useState<string | null>(null);
  const [pending, setPending] = useState<Shape | null>(null);

  // Read through refs inside the window listeners, so a commit does not have
  // to tear the drag down and rebuild it midway through.
  const latest = useRef({ shapes, onChange, orientation });
  latest.current = { shapes, onChange, orientation };

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled || e.button !== 2 || !boardRef.current) return;
      const sq = squareAt(boardRef.current, e.clientX, e.clientY, orientation);
      if (!sq) return;
      // Nothing is drawn yet: a press is only a circle once it is released
      // without having moved, and showing one now would flicker on every drag.
      setFrom(sq);
      setPending(null);
    },
    [disabled, orientation]
  );

  useEffect(() => {
    if (from === null) return;
    const board = boardRef.current;
    if (!board) return;

    const move = (e: MouseEvent) => {
      const sq = squareAt(board, e.clientX, e.clientY, latest.current.orientation);
      setPending(sq && sq !== from ? { from, to: sq, brush: brushFor(e) } : null);
    };

    const up = (e: MouseEvent) => {
      if (e.button !== 2) return; // another button; this gesture is still live
      const sq = squareAt(board, e.clientX, e.clientY, latest.current.orientation);
      const brush = brushFor(e);
      // Released where it started - or off the board, which is the same
      // intention badly aimed: a ring on the square that was pressed.
      const shape: Shape =
        !sq || sq === from ? { from, brush } : { from, to: sq, brush };

      setFrom(null);
      setPending(null);
      latest.current.onChange(toggleShape(latest.current.shapes, shape));
    };

    // A press that never gets its release - the window lost focus mid-drag, or
    // the tab was switched away - would otherwise stay armed indefinitely.
    const abandon = () => {
      setFrom(null);
      setPending(null);
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", abandon);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", abandon);
    };
  }, [from]);

  // Right-clicking a board should never raise the browser's menu over it.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!disabled) e.preventDefault();
    },
    [disabled]
  );

  return {
    boardRef,
    pending,
    /** Spread onto the element that wraps the board and matches its size. */
    handlers: { onMouseDown, onContextMenu },
  };
}
