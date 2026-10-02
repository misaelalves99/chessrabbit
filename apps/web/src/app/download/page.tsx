import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import DonateSection from "@/components/DonateSection";

const SOURCE = "https://github.com/shivamjg101/chessrabbit/tree/codex/open-source-local-engines";

export default function DownloadPage() {
  return <div className="mx-auto min-h-screen max-w-3xl px-4 py-10">
    <Link href="/app" className="text-sm text-accent">← Open the board</Link>
    <h1 className="mt-6 font-display text-4xl">ChessRabbit on your computer</h1>
    <p className="mt-4 text-muted">Free, open-source chess analysis and training. Your games and analysis stay in your local database.</p>
    <ol className="mt-8 list-decimal space-y-4 pl-5 text-sm">
      <li>Install Docker Desktop on Windows or macOS, or Docker Engine with Compose on Linux.</li>
      <li>Download the source from <a className="text-accent underline" href={SOURCE}>GitHub</a> and extract it.</li>
      <li>In the extracted folder, run <code className="font-mono">docker compose up --build -d</code>.</li>
      <li>Open <a className="text-accent underline" href="http://localhost:3000/app">localhost:3000/app</a>. Local mode creates your personal workspace automatically.</li>
    </ol>
    <section className="mt-8 rounded-lg border border-ivory/10 p-5">
      <h2 className="font-display text-xl">Choose your engine</h2>
      <p className="mt-2 text-sm text-muted">Stockfish is included in the Docker setup. Add Leela Chess Zero and a network file, or configure another UCI engine, then choose it in Analysis settings. Engines use your own CPU or GPU.</p>
      <a className="mt-3 block text-sm text-accent underline" href="https://github.com/shivamjg101/chessrabbit/blob/codex/open-source-local-engines/docs/LOCAL_SETUP.md">Read the local setup and engine guide</a>
    </section>
    <p className="mt-6 text-xs text-muted">GPL-3.0. No subscription or license key. The initial build needs internet access; local PGN analysis works offline after installation. Online imports and live opening statistics require a connection.</p>
    <div className="mt-8"><DonateSection /></div>
    <SiteFooter />
  </div>;
}
