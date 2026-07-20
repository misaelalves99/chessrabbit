import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChessRabbit — Chess Database & Analysis",
  description:
    "Study chess with a full game database, server-side Stockfish analysis, and an opening explorer.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-panel text-ink antialiased">{children}</body>
    </html>
  );
}
