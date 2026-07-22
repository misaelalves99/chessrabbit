import Link from "next/link";

const FEATURES = [
  {
    icon: "🔍",
    title: "Full game review",
    text: "Every move classified and explained — accuracy, blunders, and the move you missed.",
  },
  {
    icon: "🧩",
    title: "Tactics puzzles",
    text: "20,000 real Lichess puzzles with a rating that adapts to you, plus Puzzle Rush.",
  },
  {
    icon: "♟",
    title: "Play vs Stockfish",
    text: "Eight strength levels from beginner to full engine, with hints when you're stuck.",
  },
  {
    icon: "📚",
    title: "Opening explorer",
    text: "52,000+ master games of live win statistics, and spaced-repetition opening drills.",
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
    <main className="min-h-screen flex flex-col items-center justify-center gap-10 p-8">
      <div className="text-center max-w-2xl animate-rise">
        <span className="inline-block text-xs text-accent2 border border-accent2/30 bg-accent2/10 rounded-full px-3 py-1 mb-5">
          ⚙ Stockfish 16 · server-side · nothing to install
        </span>
        <h1 className="font-display text-6xl font-bold tracking-tight mb-4">
          Chess
          <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent">
            Rabbit
          </span>
        </h1>
        <p className="text-muted text-lg leading-relaxed">
          Your complete chess workspace — review games like a coach, drill
          openings and tactics, and spar with the engine at your level.
        </p>
      </div>

      <div className="flex gap-4 animate-rise" style={{ animationDelay: "0.1s" }}>
        <Link href="/register" className="btn-primary text-base px-6 py-2.5">
          Create free account
        </Link>
        <Link href="/login" className="btn px-6 py-2.5 text-base">
          Sign in
        </Link>
      </div>

      <div
        className="flex gap-8 flex-wrap justify-center animate-rise"
        style={{ animationDelay: "0.2s" }}
      >
        {STATS.map((s) => (
          <div key={s.label} className="text-center">
            <div className="font-display text-2xl font-bold text-ink">{s.value}</div>
            <div className="text-xs text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      <div
        className="grid sm:grid-cols-2 gap-4 max-w-3xl w-full animate-rise"
        style={{ animationDelay: "0.3s" }}
      >
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="bg-panelAlt/60 border border-white/5 rounded-xl p-5
                       transition-all duration-150 hover:border-accent/40
                       hover:-translate-y-0.5 hover:shadow-card"
          >
            <div className="text-2xl mb-2">{f.icon}</div>
            <h3 className="font-display font-semibold mb-1">{f.title}</h3>
            <p className="text-sm text-muted leading-relaxed">{f.text}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
