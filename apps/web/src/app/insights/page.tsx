"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ApiError, Insights, InsightsRange, InsightsSource, OtbPlayer, TimeClass, api,
  getAccessToken,
} from "@/lib/api";
import {
  CalendarSection, GamesSection, MovesSection, OpeningsSection,
  PhasesSection, ResultsSection,
} from "@/components/InsightsSections";

const SECTIONS = [
  { id: "games", label: "Games", icon: "♟", hint: "How are the games going?" },
  { id: "results", label: "Results", icon: "🏁", hint: "How do they end?" },
  { id: "phases", label: "Phases & shapes", icon: "◱", hint: "Where are they decided?" },
  { id: "openings", label: "Openings", icon: "📖", hint: "What gets played, and how does it go?" },
  { id: "moves", label: "Moves", icon: "◇", hint: "Where do the strengths lie?" },
  { id: "calendar", label: "Calendar", icon: "🗓", hint: "When are the best results?" },
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

const SOURCES: { id: InsightsSource; label: string; hint: string }[] = [
  { id: "lichess", label: "Lichess", hint: "lichess username" },
  { id: "chesscom", label: "Chess.com", hint: "chess.com username" },
  { id: "otb", label: "Over the board", hint: "e.g. Carlsen, Magnus" },
];

/** Who the page is about: the signed-in user, or somebody looked up. */
type Subject = { kind: "me" } | { kind: "player"; source: InsightsSource; name: string };

export default function InsightsPage() {
  const router = useRouter();
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<SectionId>("games");

  const [timeClass, setTimeClass] = useState<TimeClass | "all">("all");
  const [range, setRange] = useState<InsightsRange>("all");
  const [color, setColor] = useState<"all" | "w" | "b">("all");

  const [subject, setSubject] = useState<Subject>({ kind: "me" });
  // Looking someone up is a Master feature; a 402 becomes an upsell rather
  // than a red error, since it is a price tag and not a failure.
  const [locked, setLocked] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const query = {
      timeClass: timeClass === "all" ? undefined : timeClass,
      range,
      color: color === "all" ? undefined : color,
    };
    const req =
      subject.kind === "me"
        ? api.insights(query)
        : api.playerInsights(subject.source, subject.name, query);

    req
      .then((res) => {
        setData(res);
        setError(null);
        setLocked(false);
      })
      .catch((err) => {
        setData(null);
        if (err instanceof ApiError && err.code === "upgrade_required") {
          setLocked(true);
          setError(null);
          return;
        }
        setLocked(false);
        setError(
          err instanceof ApiError
            ? err.message
            : subject.kind === "me"
              ? "Could not load your insights"
              : "Could not load that player"
        );
      })
      .finally(() => setLoading(false));
  }, [timeClass, range, color, subject]);

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
          <h1 className="font-display text-lg font-bold leading-none">
            {subject.kind === "me" ? "Insights" : subject.name}
          </h1>
          <p className="truncate text-[11px] text-muted">
            {data
              ? `${data.games.toLocaleString()} games analysed${
                  data.source
                    ? ` · ${SOURCES.find((s) => s.id === data.source)?.label}`
                    : ""
                }`
              : subject.kind === "me"
                ? "Reading your games…"
                : `Reading ${subject.name}'s games…`}
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
        <div className="mx-auto max-w-6xl space-y-2">
          <SubjectPicker subject={subject} onChange={setSubject} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
              {data.engine_metrics === false ? (
                <p>
                  Built from{" "}
                  <span className="font-mono font-semibold text-ink">
                    {data.games.toLocaleString()}
                  </span>{" "}
                  games, replaying the most recent{" "}
                  {(data.replayed ?? 0).toLocaleString()} for the piece and
                  castling charts. Accuracy and move quality need an engine
                  review, which we only run on your own games.
                </p>
              ) : (
                <p>
                  <span className="font-mono font-semibold text-ink">
                    {data.reviewed.toLocaleString()}
                  </span>{" "}
                  of your games have an engine review. Accuracy, phases, shapes and
                  move quality are built from those.
                </p>
              )}
              {data.engine_metrics !== false && data.unattributed > 0 && (
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

          {locked && !loading && (
            <div className="card p-6 text-center">
              <p className="font-display text-lg font-semibold">
                Looking up other players is a Master feature
              </p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
                Master unlocks insights for any Lichess or Chess.com account, and
                the over-the-board careers of players in the reference database.
                Your own insights stay free.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Link href="/pricing" className="btn-primary text-sm">
                  See plans
                </Link>
                <button
                  className="btn text-sm"
                  onClick={() => setSubject({ kind: "me" })}
                >
                  Back to mine
                </button>
              </div>
            </div>
          )}

          {data && data.games === 0 && !loading && (
            <div className="card p-6 text-center">
              <p className="font-display text-lg font-semibold">Nothing to show yet</p>
              {subject.kind === "me" ? (
                <>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
                    Insights are built from your own games. Connect your Lichess or
                    Chess.com account and your history imports automatically — then
                    this page fills in.
                  </p>
                  <Link href="/app" className="btn-primary mt-4 inline-block text-sm">
                    Connect an account
                  </Link>
                </>
              ) : (
                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
                  No finished games for {subject.name} with these filters. Try
                  widening the range or clearing the time class.
                </p>
              )}
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

/**
 * Choose whose insights to read.
 *
 * Over-the-board is a picker rather than free text: reference PGNs spell names
 * "Lastname, Firstname", which nobody guesses correctly, and an exact match is
 * what lets the query use the indexed lower(white)/lower(black) columns.
 */
function SubjectPicker({
  subject,
  onChange,
}: {
  subject: Subject;
  onChange: (s: Subject) => void;
}) {
  const [open, setOpen] = useState(subject.kind === "player");
  const [source, setSource] = useState<InsightsSource>(
    subject.kind === "player" ? subject.source : "lichess"
  );
  const [text, setText] = useState(subject.kind === "player" ? subject.name : "");
  const [matches, setMatches] = useState<OtbPlayer[]>([]);

  // Only the OTB source can suggest names — we hold that database. Debounced
  // so typing does not fire a query per keystroke.
  useEffect(() => {
    if (source !== "otb" || text.trim().length < 2) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      api.searchOtbPlayers(text.trim()).then(setMatches).catch(() => setMatches([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [source, text]);

  const submit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setMatches([]);
    onChange({ kind: "player", source, name: trimmed });
  };

  const active = SOURCES.find((s) => s.id === source)!;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="seg">
        <button
          className={`seg-item text-xs ${subject.kind === "me" ? "seg-item-on" : ""}`}
          onClick={() => {
            onChange({ kind: "me" });
            setOpen(false);
          }}
        >
          You
        </button>
        <button
          className={`seg-item text-xs ${subject.kind === "player" ? "seg-item-on" : ""}`}
          onClick={() => setOpen(true)}
        >
          Another player
        </button>
      </div>

      {open && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className={`seg-item text-xs ${source === s.id ? "seg-item-on" : ""}`}
                onClick={() => {
                  setSource(s.id);
                  setMatches([]);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="relative">
            <input
              className="input w-56 py-1 text-sm"
              placeholder={active.hint}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit(text);
                if (e.key === "Escape") setMatches([]);
              }}
              aria-label={`Search by ${active.hint}`}
            />
            {matches.length > 0 && (
              <ul className="card absolute left-0 top-full z-50 mt-1 max-h-64 w-72 overflow-y-auto p-1 shadow-card">
                {matches.map((m) => (
                  <li key={m.name}>
                    <button
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06]"
                      onClick={() => {
                        setText(m.name);
                        submit(m.name);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted">
                        {m.games.toLocaleString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button className="btn text-xs" onClick={() => submit(text)} disabled={!text.trim()}>
            Show
          </button>
        </div>
      )}
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
