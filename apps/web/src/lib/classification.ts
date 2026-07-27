import type { Classification } from "@/lib/api";

/**
 * How each move verdict is drawn: the badge glyph, the badge fill, and the
 * text colour used in the move list. Colours run cool-to-hot so a move list
 * can be skimmed for trouble without reading a single symbol.
 */
export const CLASS_META: Record<
  Classification,
  { glyph: string; color: string; label: string; bg: string }
> = {
  book: { glyph: "📖", color: "text-[#d0b184]", label: "Book", bg: "#a3865f" },
  best: { glyph: "★", color: "text-accent", label: "Best", bg: "#8B7CFF" },
  excellent: { glyph: "✓", color: "text-good", label: "Excellent", bg: "#7FD858" },
  good: { glyph: "✓", color: "text-good/70", label: "Good", bg: "#5FA83F" },
  inaccuracy: { glyph: "?!", color: "text-gold", label: "Inaccuracy", bg: "#FFC53D" },
  mistake: { glyph: "?", color: "text-warn", label: "Mistake", bg: "#FF9F3D" },
  blunder: { glyph: "??", color: "text-bad", label: "Blunder", bg: "#FF5F63" },
};

/** Order used wherever verdicts are listed: strongest first, worst last. */
export const CLASS_ORDER: Classification[] = [
  "best",
  "excellent",
  "good",
  "book",
  "inaccuracy",
  "mistake",
  "blunder",
];

/** Names the move and its verdict, the way a coach would say it. */
export function headline(san: string, cls: Classification): string {
  switch (cls) {
    case "book":
      return `${san} is a book move`;
    case "best":
      return `${san} is the best move`;
    case "excellent":
      return `${san} is excellent`;
    case "good":
      return `${san} is a good move`;
    case "inaccuracy":
      return `${san} is an inaccuracy`;
    case "mistake":
      return `${san} is a mistake`;
    case "blunder":
      return `${san} is a blunder`;
  }
}
