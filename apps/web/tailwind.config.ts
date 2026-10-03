import type { Config } from "tailwindcss";

// Ink and brass — a study, not a clubhouse.
//
// The previous palette was walnut: a wooden board on a dark table, with
// chess.com's green as the action colour. It was warm and it was competent, but
// it was also the two most predictable moves available — brown timber for
// "chess", borrowed green for "go" — and it said nothing about what this app
// actually does.
//
// What it does is schedule your memory. SM-2 serves a position back at the
// moment just before you would have forgotten it. That belongs to instruments
// and index cards, so: ink navy ground, brass hardware, chalk marks.
//
// Three rules hold it together, and breaking any one of them collapses the
// system back into a generic dark dashboard:
//
//   1. VERDIGRIS AND CORAL ARE SEMANTIC ONLY. Verdigris means "right" —
//      correct answer, best move, line retained. Coral means "lost" — blunder,
//      forgotten, failed. Neither is ever used because a thing needed a colour.
//   2. BRASS IS THE ONLY DECORATIVE COLOUR. Hardware, tick marks, rules, the
//      primary action. If something needs to be noticed and isn't a verdict,
//      it is brass.
//   3. EVERY SURFACE IS COOL AND EVERY MARK ON IT IS WARM. The ground steps
//      night → panel → panelAlt → raise in blue; text is chalk, a warm off-
//      white. That one temperature clash is what keeps the ink from reading as
//      slate-grey nothing.
//
// Every colour below is validated by apps/web/scripts/palette-check.py against
// `panel` — CIEDE2000 separation, dichromat simulation, WCAG contrast. Change
// one and re-run it; the numbers quoted in lib/vizTheme.ts come from there.
//
// Move verdicts (best / inaccuracy / blunder …) are derived from this palette
// in lib/classification.ts rather than borrowed; see the note there.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Fallback squares only. The real board colours come from
        // lib/boardTheme.ts, which the user can switch at runtime.
        board: {
          light: "#DCD9CC",
          dark: "#4A737E",
        },
        // Surfaces, darkest to lightest. `night` is the page, `panel` a card,
        // `panelAlt` a card on a card, `raise` a hover/active row. Deliberately
        // not called `base` — that would collide with the `text-base` font-size
        // utility and silently repaint anything using it.
        night: "#0D1728",
        panel: "#152438",
        panelAlt: "#1D3050",
        raise: "#26405F",
        line: "#2F4A6B",
        // Chalk, not white: a warm mark on a cool ground. Pure white here reads
        // as a hole in the page rather than as writing on it.
        ink: "#F2F0EA",
        muted: "#93A6C2",
        faint: "#6B7F9C",

        // The instrument. Hardware, rules, tick marks, the primary action.
        brass: "#C99C56",
        brassLit: "#E5BE77",
        // Kept as an alias because 36 call sites already say `gold`.
        gold: "#C99C56",

        // "Right." Correct answer, best move, line retained. Nothing else.
        accent: "#3FBFA3",
        // "Lost." Blunder, forgotten, failed. Nothing else.
        bad: "#F2604E",

        // Engine lines and arrows, which have to stay legible drawn on top of
        // a light chalk square. Violet, so an engine suggestion is never
        // mistaken for a verdict.
        accent2: "#8B7BE8",

        good: "#9AD3BF",
        warn: "#EDA04B",

        // The two piece colours, for anything that has to stand for a side away
        // from the board: player swatches, the eval bar, result badges. Chalk
        // and ink, matching the board they came from.
        ivory: "#EFEBE0",
        ebony: "#16202F",
      },
      fontFamily: {
        // The variables are supplied by next/font in layout.tsx; the literal
        // names stay as fallbacks so a locally-installed copy still applies.
        sans: ["var(--font-sans)", "Archivo", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Instrument Serif", "ui-serif", "Georgia", "serif"],
        // Algebraic notation is the app's third typeface, not a caption face.
        mono: ["var(--font-mono)", "IBM Plex Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        // Ink is a dark, cool ground: a glow on it has to be cool too, or it
        // reads as a smudge.
        glow: "0 2px 12px rgba(63, 191, 163, 0.28)",
        "glow-lg": "0 6px 26px rgba(63, 191, 163, 0.4)",
        card: "0 12px 36px rgba(3, 8, 18, 0.55)",
        // The board sits on its own plane, lifted off the page.
        board: "0 24px 60px rgba(3, 8, 18, 0.7)",
        // 1px inner top highlight — reads as a lit edge on a dark surface.
        edge: "inset 0 1px 0 rgba(242, 240, 234, 0.07)",
        // A brass hairline around the board, replacing the old timber surround.
        frame: "inset 0 0 0 1px rgba(201, 156, 86, 0.55), 0 1px 0 rgba(3, 8, 18, 0.6)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pop: {
          "0%": { opacity: "0", transform: "scale(0.6)" },
          "60%": { opacity: "1", transform: "scale(1.12)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        rise: "rise 0.4s ease-out both",
        pop: "pop 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) both",
      },
    },
  },
  plugins: [],
};
export default config;
