import type { Metadata } from "next";
import Link from "next/link";
import DonateSection from "@/components/DonateSection";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Donate — ChessRabbit",
  description: "Support free, open-source chess analysis and training with an optional donation to ChessRabbit.",
};

export default function DonatePage() {
  return (
    <>
      <main className="mx-auto max-w-4xl px-5 py-10 sm:py-16">
        <Link href="/app" className="text-sm text-brassLit underline-offset-4 hover:underline">
          ← Open the board
        </Link>
        <h1 className="mt-8 font-display text-4xl text-ink">Support ChessRabbit</h1>
        <p className="mb-8 mt-3 text-sm leading-relaxed text-muted">
          Free to download, run on your computer, and make your own.
        </p>
        <DonateSection />
      </main>
      <SiteFooter />
    </>
  );
}
