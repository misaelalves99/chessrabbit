import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center max-w-xl">
        <h1 className="text-5xl font-bold mb-4">
          Chess<span className="text-accent">Rabbit</span>
        </h1>
        <p className="text-muted text-lg">
          A chess database and analysis workspace. Import your games, run
          server-side Stockfish, explore openings against a reference database.
        </p>
      </div>

      <div className="flex gap-4">
        <Link href="/register" className="btn-primary">
          Create account
        </Link>
        <Link href="/login" className="btn px-4 py-2">
          Sign in
        </Link>
      </div>

      <ul className="text-sm text-muted space-y-1 text-center">
        <li>♟ Unlimited analysis boards</li>
        <li>⚙ Stockfish 16 running server-side — nothing to install</li>
        <li>📚 Opening explorer with win statistics</li>
        <li>📥 PGN import, collections, and engine annotations</li>
      </ul>
    </main>
  );
}
