import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

// Self-hosted and preloaded at build time, so first paint never waits on a
// third-party round trip. `display: swap` means text is readable immediately
// and the variable handoff to Tailwind keeps `font-sans` / `font-display`
// working exactly as before.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-sans",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "ChessRabbit — Chess Database & Analysis",
  description:
    "Study chess with a full game database, server-side Stockfish analysis, and an opening explorer.",
};

// Dark UI end to end: tell the browser so form controls and the mobile
// address bar match the page instead of flashing white.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#080B16",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`h-full ${inter.variable} ${spaceGrotesk.variable}`}
    >
      <body className="min-h-full text-ink antialiased font-sans">{children}</body>
    </html>
  );
}
