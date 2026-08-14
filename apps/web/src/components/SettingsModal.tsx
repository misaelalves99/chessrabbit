"use client";

import { useState } from "react";
import Link from "next/link";
import { Me } from "@/lib/api";
import { BOARD_THEMES } from "@/lib/boardTheme";
import {
  DEFAULTS, DEPTH_CHOICES as DEPTHS, LINE_CHOICES as LINES,
  resetSettings, updateSettings, useSettings,
} from "@/lib/settings";

const ENGINE_NAME = "Stockfish 18";
const SPEEDS = [
  { ms: 0, label: "Off" },
  { ms: 120, label: "Fast" },
  { ms: 200, label: "Normal" },
  { ms: 350, label: "Slow" },
];

type Tab = "engine" | "interface" | "board";

const TABS: { id: Tab; label: string }[] = [
  { id: "engine", label: "Engine" },
  { id: "interface", label: "Interface" },
  { id: "board", label: "Board" },
];

interface Props {
  me: Me | null;
  onClose: () => void;
}

/** A labelled on/off row — the shape every interface preference uses. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-ivory/[0.04]">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs leading-relaxed text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </div>
  );
}

export default function SettingsModal({ me, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("engine");
  const s = useSettings();

  // The socket clamps both of these to the plan ceiling server-side, so the UI
  // shows the real limit rather than letting someone pick a number that would
  // be silently ignored.
  const maxDepth = me?.max_depth ?? DEFAULTS.depth;
  const maxLines = me?.max_multipv ?? DEFAULTS.multipv;
  const capped = me != null && me.plan === "free";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Analysis settings"
    >
      <div
        className="card flex max-h-[85dvh] w-full max-w-lg flex-col shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-ivory/[0.07] px-4 py-3">
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            className="ml-auto rounded-lg px-2 py-1 text-muted transition-colors hover:bg-ivory/[0.07] hover:text-ink"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="shrink-0 px-4 pt-3">
          <div className="seg w-full justify-between">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-pressed={tab === t.id}
                className={`seg-item flex-1 text-center text-xs ${
                  tab === t.id ? "seg-item-on" : ""
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* ------------------------------------------------ Engine ---- */}
          {tab === "engine" && (
            <div className="space-y-4">
              <section>
                <p className="eyebrow mb-1">Game review</p>
                <Row label="Engine">
                  <span className="font-mono text-sm">{ENGINE_NAME}</span>
                </Row>
                <p className="text-xs leading-relaxed text-muted">
                  Reviews run server-side at your plan&apos;s strength — there is
                  nothing to download, and the engine never runs in your browser.
                </p>
                {capped && (
                  <Link
                    href="/pricing"
                    className="mt-2 flex items-center gap-2 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs transition-colors hover:bg-gold/15"
                  >
                    <span aria-hidden>★</span>
                    <span>Upgrade for deeper analysis and more lines</span>
                    <span className="ml-auto text-gold">→</span>
                  </Link>
                )}
              </section>

              <section className="border-t border-ivory/[0.06] pt-3">
                <p className="eyebrow mb-1">Analysis</p>

                <Row label="Search depth">
                  <select
                    className="input w-40"
                    value={s.depth}
                    onChange={(e) => updateSettings({ depth: Number(e.target.value) })}
                  >
                    {DEPTHS.map((d) => (
                      <option key={d} value={d} disabled={d > maxDepth}>
                        {d > maxDepth ? `Depth ${d} — locked` : `Depth ${d}`}
                      </option>
                    ))}
                  </select>
                </Row>

                <Row label="Number of lines">
                  <select
                    className="input w-40"
                    value={s.multipv}
                    onChange={(e) => updateSettings({ multipv: Number(e.target.value) })}
                  >
                    {LINES.map((n) => (
                      <option key={n} value={n} disabled={n > maxLines}>
                        {n > maxLines ? `${n} lines — locked` : `${n} line${n > 1 ? "s" : ""}`}
                      </option>
                    ))}
                  </select>
                </Row>

                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Your plan allows depth {maxDepth} and {maxLines} line
                  {maxLines > 1 ? "s" : ""}. Deeper searches take longer and are
                  capped server-side.
                </p>
              </section>

              <section className="border-t border-ivory/[0.06] pt-2">
                <Toggle
                  label="Auto-analyse on move"
                  hint="Re-run the engine every time the position changes."
                  checked={s.autoAnalyse}
                  onChange={(autoAnalyse) => updateSettings({ autoAnalyse })}
                />
              </section>
            </div>
          )}

          {/* --------------------------------------------- Interface ---- */}
          {tab === "interface" && (
            <div className="space-y-1">
              <Toggle
                label="Evaluation bar"
                hint="The vertical bar beside the board."
                checked={s.showEvalBar}
                onChange={(showEvalBar) => updateSettings({ showEvalBar })}
              />
              <Toggle
                label="Best-move arrow"
                hint="On reviewed games, draw the move the engine preferred."
                checked={s.showBestArrow}
                onChange={(showBestArrow) => updateSettings({ showBestArrow })}
              />
              <Toggle
                label="Move verdict badge"
                hint="The brilliant/blunder marker on the destination square."
                checked={s.showVerdictBadge}
                onChange={(showVerdictBadge) => updateSettings({ showVerdictBadge })}
              />

              <div className="border-t border-ivory/[0.06] pt-2">
                <Row label="Piece animation">
                  <div className="seg">
                    {SPEEDS.map((sp) => (
                      <button
                        key={sp.ms}
                        onClick={() => updateSettings({ animationMs: sp.ms })}
                        className={`seg-item text-xs ${
                          s.animationMs === sp.ms ? "seg-item-on" : ""
                        }`}
                      >
                        {sp.label}
                      </button>
                    ))}
                  </div>
                </Row>
              </div>
            </div>
          )}

          {/* ------------------------------------------------- Board ---- */}
          {tab === "board" && (
            <div className="space-y-4">
              <section>
                <p className="eyebrow mb-2">Board theme</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {BOARD_THEMES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => updateSettings({ boardTheme: t.id })}
                      aria-pressed={s.boardTheme === t.id}
                      className={`rounded-xl p-2 text-left transition-all ${
                        s.boardTheme === t.id
                          ? "bg-accent/15 ring-2 ring-accent"
                          : "ring-1 ring-ivory/[0.08] hover:ring-ivory/25"
                      }`}
                    >
                      {/* 4x4 slice of the real board, so the swatch is the thing
                          it is selecting rather than an approximation. */}
                      <div className="mb-1.5 grid grid-cols-4 overflow-hidden rounded-md">
                        {Array.from({ length: 16 }).map((_, i) => {
                          const dark = (Math.floor(i / 4) + i) % 2 === 1;
                          return (
                            <div
                              key={i}
                              className="aspect-square"
                              style={{ background: dark ? t.dark : t.light }}
                            />
                          );
                        })}
                      </div>
                      <span className="text-xs">{t.label}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="border-t border-ivory/[0.06] pt-2">
                <Toggle
                  label="Coordinates"
                  hint="File letters and rank numbers on the board edge."
                  checked={s.showCoordinates}
                  onChange={(showCoordinates) => updateSettings({ showCoordinates })}
                />
                <Toggle
                  label="Highlight last move"
                  hint="Tint the squares the last move came from and went to."
                  checked={s.highlightLastMove}
                  onChange={(highlightLastMove) => updateSettings({ highlightLastMove })}
                />
              </section>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-ivory/[0.07] px-4 py-3">
          <button className="btn text-xs" onClick={resetSettings}>
            Reset to defaults
          </button>
          <button className="btn-primary ml-auto text-sm" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
