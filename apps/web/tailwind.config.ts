import type { Config } from "tailwindcss";

// Royal indigo theme, tuned for long sessions: desaturated indigo-slate
// surfaces (low-chroma darks strain eyes less than vivid blue), soft off-white
// text (no glare), vivid violet/cyan/gold kept to small elements only.
// Board is the lichess-style blue-grey - proven comfortable to stare at.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        board: {
          light: "#DCE1E7",
          dark: "#8CA2AD",
        },
        panel: "#191C2B",
        panelAlt: "#212539",
        ink: "#E3E6F2",
        muted: "#8E96B3",
        accent: "#818CF8",
        accent2: "#22D3EE",
        gold: "#FBBF24",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Space Grotesk", "Inter", "ui-sans-serif", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glow: "0 4px 14px rgba(99, 102, 241, 0.25)",
        "glow-lg": "0 6px 24px rgba(99, 102, 241, 0.4)",
        card: "0 8px 24px rgba(4, 6, 18, 0.45)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        rise: "rise 0.45s ease-out both",
      },
    },
  },
  plugins: [],
};
export default config;
