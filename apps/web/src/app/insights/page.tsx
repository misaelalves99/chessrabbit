"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ApiError, Insights, InsightsRange, TimeClass, api, getAccessToken,
} from "@/lib/api";
import {
  CalendarSection, GamesSection, MovesSection, OpeningsSection,
  PhasesSection, ResultsSection,
} from "@/components/InsightsSections";

const SECTIONS = [
  { id: "games", label: "Games", icon: "♟", hint: "How are your games going?" },
  { id: "results", label: "Results", icon: "🏁", hint: "How do they end?" },
  { id: "phases", label: "Phases & shapes", icon: "◱", hint: "Where are they decided?" },
  { id: "openings", label: "Openings", icon: "📖", hint: "What do you play, and how does it go?" },
  { id: "moves", label: "Moves", icon: "◇", hint: "What are your strengths?" },
  { id: "calendar", label: "Calendar", icon: "🗓", hint: "When do you play your best?" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const TIME_CLASSES: { id: TimeClass | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bullet", label: "Bullet" },
  { id: "blitz", label: "Blitz" },
  { id: "rapid", label: "Rapid" },
  { id: "classical", label: "Classical" },
];

const RANGES: { id: InsightsRange; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "1y", label: "Last year" },
  { id: "90d", label: "90 days" },
  { id: "30d", label: "30 days" },
];

const COLORS: { id: "all" | "w" | "b"; label: string }[] = [
  { id: "all", label: "Both" },
  { id: "w", label: "White" },
  { id: "b", label: "Black" },
];

export default function InsightsPage() {
  const router = useRouter();
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<SectionId>("games");

  const [timeClass, setTimeClass] = useState<TimeClass | "all">("all");
  const [range, setRange] = useState<InsightsRange>("all");
  const [color, setColor] = useState<"all" | "w" | "b">("all");

  const load = useCallback(() => {
    setLoading(true);
    api
      .insights({
        timeClass: timeClass === "all" ? undefined : timeClass,
        range,
        color: color === "all" ? undefined : color,
      })
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : "Could not load your insights"
        )
      )
      .finally(() => setLoading(false));
  }, [timeClass, range, color]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.push("/login");
      return;
    }
    load();
  }, [router, load]);

  const body = () => {
    if (!data) return null;
    switch (section) {
      case "games": return <GamesSection data={data} />;
      case "results": return <ResultsSection data={data} />;
      case "phases": return <PhasesSection data={data} />;
      case "openings": return <OpeningsSection data={data} />;
      case "moves": return <MovesSection data={data} />;
      case "calendar": return <CalendarSection data={data} />;
    }
  };

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="min-h-dvh">
      {/* ---------- Header ---------- */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-white/[0.07] bg-panel/70 px-3 backdrop-blur-xl">
        <Link href="/app" className="btn px-2" aria-label="Back to the board">
          ←
        </Link>
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent2 text-base shadow-glow">
          💡
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-lg font-bold leading-none">Insights</h1>
          <p className="truncate text-[11px] text-muted">
            {data ? `${data.games.toLocaleString()} games analysed` : "Reading your games…"}
          </p>
        </div>
        <nav className="seg ml-auto hidden md:flex">
          {[
            { href: "/app", label: "Analyse" },
            { href: "/train", label: "Train" },
            { href: "/play", label: "Play" },
            { href: "/insights", label: "Insights", active: true },
          ].map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`seg-item ${n.active ? "seg-item-on" : ""}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </header>

      {/* ---------- Filters ---------- */}
      <div className="sticky top-14 z-30 border-b border-white/[0.07] bg-panel/60 px-3 py-2.5 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
          <FilterGroup
            label="Time class"
            options={TIME_CLASSES}
            value={timeClass}
            onChange={setTimeClass}
          />
          <FilterGroup label="Colour" options={COLORS} value={color} onChange={setColor} />
          <FilterGroup label="Range" options={RANGES} value={range} onChange={setRange} />
        </div>
      </div>

      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-3 py-5 lg:flex-row-reverse">
        {/* ---------- Section rail ---------- */}
        <aside className="lg:sticky lg:top-32 lg:h-fit lg:w-56 lg:shrink-0">
          <nav className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors lg:w-full ${
                  section === s.id
                    ? "bg-accent/15 text-accent ring-1 ring-accent/40"
                    : "text-muted hover:bg-white/[0.06] hover:text-ink"
                }`}
              >
                <span aria-hidden className="text-base leading-none">{s.icon}</span>
                {s.label}
              </button>
            ))}
          </nav>

          {data && (
            <div className="mt-3 hidden rounded-xl border border-white/[0.06] bg-panelAlt/50 p-3 text-[11px] leading-relaxed text-muted lg:block">
              <p>
                <span className="font-mono font-semibold text-ink">
                  {data.reviewed.toLocaleString()}
                </span>{" "}
                of your games have an engine review. Accuracy, phases, shapes and
                move quality are built from those.
              </p>
              {data.unattributed > 0 && (
                <p className="mt-2">
                  {data.unattributed.toLocaleString()} game
                  {data.unattributed === 1 ? " is" : "s are"} excluded — we
                  can&apos;t tell which side you played. Connect the account you
                  played them on and re-sync.
                </p>
              )}
            </div>
          )}
        </aside>

        {/* ---------- Body ---------- */}
        <main className="min-w-0 flex-1">
          <div className="mb-3">
            <h2 className="font-display text-xl font-bold">{current.label}</h2>
            <p className="text-sm text-muted">{current.hint}</p>
          </div>

          {error && (
            <div className="card p-4">
              <p className="text-sm text-bad">{error}</p>
              <button className="btn mt-3 text-xs" onClick={load}>
                Try again
              </button>
            </div>
          )}

          {loading && !data && (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="card h-40 animate-pulse"
                  style={{ animationDelay: `${i * 0.1}s` }}
                />
              ))}
            </div>
          )}

          {data && data.games === 0 && !loading && (
            <div className="card p-6 text-center">
              <p className="font-display text-lg font-semibold">Nothing to show yet</p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
                Insights are built from your own games. Connect your Lichess or
                Chess.com account and your history imports automatically — then
                this page fills in.
              </p>
              <Link href="/app" className="btn-primary mt-4 inline-block text-sm">
                Connect an account
              </Link>
            </div>
          )}

          {data && data.games > 0 && (
            <div className={loading ? "opacity-60 transition-opacity" : ""}>
              {body()}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="eyebrow hidden sm:inline">{label}</span>
      <div className="seg">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`seg-item text-xs ${value === o.id ? "seg-item-on" : ""}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
