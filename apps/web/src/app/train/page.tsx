"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Chessboard } from "react-chessboard";
import { useClickToMove } from "@/hooks/useClickToMove";
import {
  api, ApiError, Opening, Repertoire, TrainingCard, TrainingResult,
} from "@/lib/api";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

type Feedback = (TrainingResult & { answered: string }) | null;

export default function TrainPage() {
  const router = useRouter();
  const [reps, setReps] = useState<Repertoire[]>([]);
  const [queue, setQueue] = useState<TrainingCard[]>([]);
  const [card, setCard] = useState<TrainingCard | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [session, setSession] = useState({ right: 0, wrong: 0 });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", color: "white" as "white" | "black", pgn: "" });
  const [error, setError] = useState<string | null>(null);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [showOpenings, setShowOpenings] = useState(false);
  const [addingOpening, setAddingOpening] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, due] = await Promise.all([api.listRepertoires(), api.dueCards(20)]);
      setReps(r);
      setQueue(due);
      setCard(due[0] ?? null);
    } catch {
      router.push("/login");
    }
  }, [router]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onDrop = useCallback(
    (from: string, to: string) => {
      if (!card || feedback) return false;
      const uci = `${from}${to}`;
      api
        .answerCard(card.id, uci)
        .then((res) => {
          setFeedback({ ...res, answered: uci });
          setSession((s) =>
            res.correct
              ? { ...s, right: s.right + 1 }
              : { ...s, wrong: s.wrong + 1 }
          );
        })
        .catch(() => setError("Could not submit answer"));
      // Optimistically keep the piece where the user dropped it; the
      // feedback panel shows the verdict either way.
      return true;
    },
    [card, feedback]
  );

  const { onSquareClick, squareStyles } = useClickToMove(
    card?.fen ?? START_FEN, onDrop, !!card && !feedback
  );

  function next() {
    const rest = queue.slice(1);
    setQueue(rest);
    setCard(rest[0] ?? null);
    setFeedback(null);
    if (rest.length === 0) refresh();
  }

  async function createRep(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createRepertoire(form.name, form.color, form.pgn);
      setCreating(false);
      setForm({ name: "", color: "white", pgn: "" });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create repertoire");
    }
  }

  function toggleOpenings() {
    setShowOpenings((s) => !s);
    setCreating(false);
    if (openings.length === 0) {
      api.listOpenings().then(setOpenings).catch(() => setError("Could not load openings"));
    }
  }

  async function trainOpening(o: Opening) {
    setAddingOpening(o.id);
    setError(null);
    try {
      await api.createRepertoire(o.name, o.color, o.moves);
      setShowOpenings(false);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that opening");
    } finally {
      setAddingOpening(null);
    }
  }

  return (
    <div className="min-h-screen p-4 max-w-5xl mx-auto">
      <header className="flex items-center gap-4 mb-4">
        <Link href="/app" className="btn">← Board</Link>
        <Link href="/train/puzzles" className="btn">🧩 Puzzles</Link>
        <h1 className="text-xl font-bold">Repertoire Trainer</h1>
        <span className="ml-auto text-sm text-muted">
          Session: <span className="text-accent">{session.right} ✓</span>{" "}
          <span className="text-red-400">{session.wrong} ✗</span>
        </span>
      </header>

      {error && (
        <p className="text-sm text-red-400 mb-3 cursor-pointer" onClick={() => setError(null)}>
          {error} (dismiss)
        </p>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Drill area */}
        <div className="flex-1">
          {card ? (
            <>
              <p className="text-sm text-muted mb-2">
                <span className="text-ink">{card.repertoire_name}</span> · playing{" "}
                {card.color} · card seen {card.reps}×
              </p>
              <div className="w-[min(92vw,440px)]">
                <Chessboard
                  position={card.fen}
                  onPieceDrop={onDrop}
                  onSquareClick={onSquareClick}
                  boardOrientation={card.color}
                  arePiecesDraggable={!feedback}
                  customDarkSquareStyle={{ backgroundColor: "#739552" }}
                  customLightSquareStyle={{ backgroundColor: "#EBECD0" }}
                  customSquareStyles={squareStyles}
                />
              </div>

              {feedback ? (
                <div
                  className={`mt-3 p-3 rounded ${
                    feedback.correct ? "bg-accent/20" : "bg-red-500/20"
                  }`}
                >
                  {feedback.correct ? (
                    <p className="text-sm">
                      Correct — <span className="font-mono">{feedback.expected_san}</span>.
                      Next review in {feedback.next_due_days} day
                      {feedback.next_due_days === 1 ? "" : "s"}.
                    </p>
                  ) : (
                    <p className="text-sm">
                      Not quite. The repertoire move is{" "}
                      <span className="font-mono font-bold">{feedback.expected_san}</span>.
                      This card returns in ~10 minutes.
                    </p>
                  )}
                  <button className="btn-primary mt-2" onClick={next} autoFocus>
                    Next card ({queue.length - 1} left)
                  </button>
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted">
                  Play the repertoire move for {card.color}.
                </p>
              )}
            </>
          ) : (
            <div className="p-8 text-center text-muted bg-panelAlt rounded">
              {reps.length === 0 ? (
                <>
                  <p className="mb-2">No repertoires yet.</p>
                  <p className="text-xs">
                    Create one from a PGN — variations in parentheses become
                    the opponent branches you&apos;ll be drilled on.
                  </p>
                </>
              ) : (
                <p>
                  Nothing due right now. Come back later — spaced repetition
                  schedules each position just before you&apos;d forget it.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Repertoire list + create */}
        <aside className="w-full lg:w-72 shrink-0 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">My repertoires</h2>
            <span className="flex gap-1">
              <button
                className="btn text-xs"
                title="Turn engine-tagged mistakes from your analysed games into puzzles"
                onClick={() =>
                  api
                    .syncBlunders()
                    .then((r) => {
                      setError(null);
                      refresh();
                      if (r.cards_created === 0 && r.mistakes_found === 0)
                        setError("No analysed mistakes yet - run full-game analysis on a game first.");
                    })
                    .catch(() => setError("Could not sync blunder puzzles"))
                }
              >
                ⚡ Blunders
              </button>
              <button
                className="btn text-xs"
                title="Start a repertoire from a well-known opening"
                onClick={toggleOpenings}
              >
                {showOpenings ? "Close" : "📖 Openings"}
              </button>
              <button className="btn text-xs" onClick={() => { setCreating((c) => !c); setShowOpenings(false); }}>
                {creating ? "Cancel" : "+ New"}
              </button>
            </span>
          </div>

          {showOpenings && (
            <div className="bg-panelAlt p-3 rounded space-y-3 max-h-[28rem] overflow-auto">
              <p className="text-xs text-muted">
                Pick an opening to drill — it becomes a spaced-repetition
                repertoire you review like any other.
              </p>
              {openings.length === 0 && (
                <p className="text-xs text-muted">Loading…</p>
              )}
              {(["white", "black"] as const).map((side) => {
                const list = openings.filter((o) => o.color === side);
                if (list.length === 0) return null;
                return (
                  <div key={side}>
                    <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">
                      Play as {side}
                    </h3>
                    <ul className="space-y-1">
                      {list.map((o) => (
                        <li key={o.id} className="bg-white/5 rounded p-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{o.name}</span>
                            <span className="text-[10px] text-muted font-mono">{o.eco}</span>
                            <button
                              className="btn-primary text-xs ml-auto"
                              disabled={addingOpening !== null}
                              onClick={() => trainOpening(o)}
                            >
                              {addingOpening === o.id ? "Adding…" : "Train"}
                            </button>
                          </div>
                          <p className="text-xs text-muted mt-0.5">{o.description}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}

          {creating && (
            <form onSubmit={createRep} className="space-y-2 bg-panelAlt p-3 rounded">
              <input
                className="input text-sm"
                placeholder="Name (e.g. Italian for White)"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
              <select
                className="input text-sm"
                value={form.color}
                onChange={(e) =>
                  setForm({ ...form, color: e.target.value as "white" | "black" })
                }
              >
                <option value="white">I play White</option>
                <option value="black">I play Black</option>
              </select>
              <textarea
                className="input h-32 font-mono text-xs"
                placeholder={"1. e4 e5 ( 1... c6 2. d4 ) 2. Nf3 *"}
                value={form.pgn}
                onChange={(e) => setForm({ ...form, pgn: e.target.value })}
                required
              />
              <button className="btn-primary w-full text-sm">Create</button>
            </form>
          )}

          <ul className="space-y-1">
            {reps.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between text-sm bg-panelAlt rounded px-3 py-2"
              >
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-muted">
                    {r.color} · {r.card_count} cards ·{" "}
                    <span className={r.due_count ? "text-accent" : ""}>
                      {r.due_count} due
                    </span>
                  </div>
                </div>
                <button
                  className="text-muted hover:text-red-400 text-xs"
                  onClick={() =>
                    api.deleteRepertoire(r.id).then(refresh).catch(() => {})
                  }
                  title="Delete repertoire"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
