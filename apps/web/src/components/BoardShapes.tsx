"use client";

import { useMemo } from "react";
import { BRUSH_COLOR, Shape } from "@/lib/shapes";

/**
 * The arrows and circles drawn on a position, over the board.
 *
 * One SVG in an eight-by-eight coordinate space rather than one absolutely
 * positioned element per shape: the whole overlay then scales with the board
 * from a single `width`, and the geometry below is written in squares, which
 * is the unit the shapes are actually about.
 *
 * It never takes a click. Drawing is captured on the board's own wrapper (see
 * `useShapeDrawing`) so that pieces stay draggable underneath - an overlay
 * that swallowed events would make every square it covers unplayable.
 */

/** How far up the shaft the head begins, and how wide it is. In squares. */
const HEAD_LEN = 0.4;
const HEAD_HALF = 0.26;
/** Arrows leave the middle of their square, but not from under the piece. */
const TAIL_GAP = 0.28;
const SHAFT = 0.14;

/** Ring inset from the square's edge, and how heavy the ring is. */
const RING_R = 0.42;
const RING_W = 0.09;

interface Props {
  shapes: Shape[];
  /** The arrow currently under the mouse, drawn but not yet committed. */
  pending?: Shape | null;
  size: number;
  orientation: "white" | "black";
}

/** Square to the centre of its cell, in the 0..8 space the SVG is drawn in. */
function centre(square: string, orientation: "white" | "black") {
  const file = square.charCodeAt(0) - 97; // a=0..h=7
  const rank = parseInt(square[1], 10); // 1..8
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 8 - rank : rank - 1;
  return { x: col + 0.5, y: row + 0.5 };
}

function Arrow({ shape, orientation }: { shape: Shape; orientation: "white" | "black" }) {
  const a = centre(shape.from, orientation);
  const b = centre(shape.to!, orientation);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return null;

  const ux = dx / len;
  const uy = dy / len;
  // A very short arrow (adjacent squares) has no room for both the gap and a
  // full head, so both give way proportionally rather than the head inverting.
  const scale = Math.min(1, len / (TAIL_GAP + HEAD_LEN + 0.1));
  const gap = TAIL_GAP * scale;
  const head = HEAD_LEN * scale;
  const half = HEAD_HALF * scale;

  const tail = { x: a.x + ux * gap, y: a.y + uy * gap };
  const neck = { x: b.x - ux * head, y: b.y - uy * head };
  // Perpendicular, for the two back corners of the head.
  const px = -uy;
  const py = ux;

  const color = BRUSH_COLOR[shape.brush];
  return (
    <g fill={color} stroke={color}>
      <line
        x1={tail.x}
        y1={tail.y}
        x2={neck.x}
        y2={neck.y}
        strokeWidth={SHAFT * scale}
        strokeLinecap="round"
      />
      <polygon
        points={[
          `${b.x},${b.y}`,
          `${neck.x + px * half},${neck.y + py * half}`,
          `${neck.x - px * half},${neck.y - py * half}`,
        ].join(" ")}
        strokeWidth={0}
      />
    </g>
  );
}

export default function BoardShapes({ shapes, pending, size, orientation }: Props) {
  const drawn = useMemo(
    () => (pending ? [...shapes.filter((s) => !sameSpot(s, pending)), pending] : shapes),
    [shapes, pending]
  );

  if (!size) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[5]"
      width={size}
      height={size}
      viewBox="0 0 8 8"
      // Shapes are a layer of intent over the position, not part of it. Held
      // just short of opaque so the piece under an arrow's tail stays readable.
      style={{ opacity: 0.82 }}
      aria-hidden
    >
      {drawn.map((s, i) =>
        s.to ? (
          <Arrow key={`a${i}-${s.from}${s.to}`} shape={s} orientation={orientation} />
        ) : (
          <circle
            key={`c${i}-${s.from}`}
            cx={centre(s.from, orientation).x}
            cy={centre(s.from, orientation).y}
            r={RING_R}
            fill="none"
            stroke={BRUSH_COLOR[s.brush]}
            strokeWidth={RING_W}
          />
        )
      )}
    </svg>
  );
}

/** The shape being dragged replaces the one it is drawn over, rather than
    doubling it while the mouse is still down. */
function sameSpot(a: Shape, b: Shape): boolean {
  return a.from === b.from && a.to === b.to;
}
