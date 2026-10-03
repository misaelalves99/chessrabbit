"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Largest square that fits the referenced element, so a board can be sized to
 * the viewport instead of a fixed pixel cap. `gutter` reserves width for
 * anything sitting beside the board (the eval bar), `vGutter` height for
 * anything stacked above and below it (the player plates).
 *
 * The element must get its height from its own box - a flex track, an aspect
 * ratio - and never from the board inside it, or measuring feeds back on
 * itself.
 */
export function useSquareSize(gutter = 0, vGutter = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize(Math.max(0, Math.floor(Math.min(width - gutter, height - vGutter))));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gutter, vGutter]);

  return [ref, size] as const;
}
