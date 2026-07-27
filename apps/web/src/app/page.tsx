import Link from "next/link";

const FEATURES = [
  {
    icon: "🔍",
    title: "Full game review",
    text: "Every move classified and explained — accuracy, blunders, and the move you missed.",
    tint: "from-accent/25",
  },
  {
    icon: "🧩",
    title: "Tactics puzzles",
    text: "20,000 real Lichess puzzles with a rating that adapts to you, plus Puzzle Rush.",
    tint: "from-accent2/25",
  },
  {
    icon: "♟",
    title: "Play vs Stockfish",
    text: "Eight strength levels from beginner to full engine, with hints when you're stuck.",
    tint: "from-good/25",
  },
  {
    icon: "📚",
    title: "Opening explorer",
    text: "52,000+ master games of live win statistics, and spaced-repetition opening drills.",
    tint: "from-gold/25",
  },
];

const STATS = [
  { value: "52k+", label: "master games" },
  { value: "20k", label: "tactics puzzles" },
  { value: "8", label: "engine levels" },
  { value: "∞", label: "analysis boards" },
];

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col items-center justify-center gap-10 px-5 py-14">
      <div className="animate-rise max-w-2xl text-center">
        <span className="chip mb-5 border border-accent2/30 bg-accent2/10 text-accent2">
          ⚙ Stockfish 18 · server-side · nothing to install
        </span>
        <h1 className="mb-4 font-display text-5xl font-bold tracking-tight sm:text-7xl">
          Chess
          <span className="bg-gradient-to-r from-accent via-[#C084FC] to-accent2 bg-clip-text text-transparent">
            Rabbit
          </span>
        </h1>
        <p className="text-lg leading-relaxed text-muted">
          Your complete chess workspace — review games like a coach, drill
          openings and tactics, and spar with the engine at your level.
        </p>
      </div>

      <div
        className="animate-rise flex flex-wrap justify-center gap-3"
        style={{ animationDelay: "0.1s" }}
      >
        <Link href="/register" className="btn-primary px-6 py-2.5 text-base">
          Create free account
        </Link>
        <Link href="/login" className="btn px-6 py-2.5 text-base">
          Sign in
        </Link>
      </div>

      <div
        className="animate-rise flex flex-wrap justify-center gap-x-10 gap-y-5"
        style={{ animationDelay: "0.2s" }}
      >
        {STATS.map((s) => (
          <div key={s.label} className="text-center">
            <div className="font-display text-3xl font-bold">
              <span className="bg-gradient-to-b from-ink to-muted bg-clip-text text-transparent">
                {s.value}
              </span>
            </div>
            <div className="text-xs uppercase tracking-wider text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      <div
        className="animate-rise grid w-full gap-4 sm:grid-cols-2"
        style={{ animationDelay: "0.3s" }}
      >
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="card group relative overflow-hidden p-5 transition-all duration-200
                       hover:-translate-y-1 hover:border-accent/40 hover:shadow-card"
          >
            {/* Corner wash — colour only shows up when you reach for the card */}
            <div
              className={`pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full
                          bg-gradient-to-br ${f.tint} to-transparent opacity-60 blur-2xl
                          transition-opacity duration-300 group-hover:opacity-100`}
            />
            <div className="relative">
              <div className="mb-2 text-2xl">{f.icon}</div>
              <h3 className="mb-1 font-display font-semibold">{f.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{f.text}</p>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
