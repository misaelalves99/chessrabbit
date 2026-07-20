import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        board: {
          light: "#EBECD0",
          dark: "#739552",
        },
        panel: "#262421",
        panelAlt: "#302E2B",
        ink: "#E8E6E3",
        muted: "#9B9894",
        accent: "#7FA650",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
