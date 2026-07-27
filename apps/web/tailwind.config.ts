import type { Config } from "tailwindcss";

// Electric indigo, tuned for long sessions.
//
// The old palette was comfortable but flat: everything sat within a few points
// of the same lightness, so nothing read as important. This one keeps the
// low-chroma dark surfaces (vivid blue backgrounds fatigue the eye over hours)
// but widens the range: near-black base, three distinct panel steps, and
// saturated accents reserved for small, meaningful elements - evals, verdicts,
// the primary action. Board squares are a periwinkle blue with high piece
// contrast.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        board: {
          light: "#E8EDFA",
          dark: "#5A73CF",
        },
        // Surfaces, darkest to lightest. `night` is the page, `panel` a card,
        // `panelAlt` a card on a card, `raise` a hover/active row. Deliberately
        // not called `base` - that would collide with the `text-base` font-size
        // utility and silently repaint anything using it.
        night: "#080B16",
        panel: "#111629",
        panelAlt: "#1A2039",
        raise: "#242C4C",
        line: "#2C3454",
        ink: "#EDF0FB",
        muted: "#9AA3C9",
        accent: "#8B7CFF",
        accent2: "#2FE3E8",
        gold: "#FFC53D",
        good: "#7FD858",
        warn: "#FF9F3D",
        bad: "#FF5F63",
      },
      fontFamily: {
        // The variables are supplied by next/font in layout.tsx; the literal
        // names stay as fallbacks so a locally-installed copy still applies.
        sans: ["var(--font-sans)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Space Grotesk", "Inter", "ui-sans-serif", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glow: "0 2px 12px rgba(139, 124, 255, 0.35)",
        "glow-lg": "0 6px 26px rgba(139, 124, 255, 0.5)",
        card: "0 10px 34px rgba(3, 5, 16, 0.55)",
        // Board sits on its own plane, lifted off the workspace.
        board: "0 18px 50px rgba(3, 5, 16, 0.6)",
        // 1px inner top highlight - reads as a lit edge on dark cards.
        edge: "inset 0 1px 0 rgba(255, 255, 255, 0.07)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pop: {
          "0%": { opacity: "0", transform: "scale(0.6)" },
          "60%": { opacity: "1", transform: "scale(1.12)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        // Slow hue drift on the ambient background - alive, but never a
        // distraction next to a board you are reading.
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "50%": { transform: "translate3d(2%, -3%, 0) scale(1.12)" },
        },
        sheen: {
          "0%": { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
      },
      animation: {
        rise: "rise 0.45s ease-out both",
        pop: "pop 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        drift: "drift 26s ease-in-out infinite",
        sheen: "sheen 2.4s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
