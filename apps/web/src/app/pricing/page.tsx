"use client";

/**
 * The three plans. Feature copy derives from /tiers (single source of truth
 * in core/tiers.py); checkout goes through the existing billing endpoint and
 * degrades to a notice until Stripe is configured.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, Me, TierInfo } from "@/lib/api";

const unlimited = (n: number) => n === -1;

function features(t: TierInfo): string[] {
  const f: string[] = [];
  f.push(
    unlimited(t.reviews_per_day)
      ? "Unlimited game reviews"
      : `${t.reviews_per_day} game reviews / day`
  );
  f.push(
    unlimited(t.puzzles_per_day)
      ? "Unlimited tactics puzzles"
      : `${t.puzzles_per_day} puzzles / day`
  );
  f.push(
    unlimited(t.rush_per_day)
      ? "Unlimited Puzzle Rush"
      : `${t.rush_per_day} Puzzle Rush run / day`
  );
  f.push(
    unlimited(t.openings_white)
      ? "Every opening, both colours"
      : `Top ${t.openings_white} White + top ${t.openings_black} Black openings`
  );
  if (t.id !== "free") f.push("Stockfish 18 server-side analysis");
  if (t.opponent_prep) f.push("🎯 Opponent prep from their real games");
  if (t.id === "master") f.push("Leela engine — coming with GPU hosting");
  return f;
}

export default function PricingPage() {
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.listTiers().then(setTiers).catch(() => {});
    api.me().then(setMe).catch(() => {});
  }, []);

  async function upgrade(tier: TierInfo) {
    if (!me) {
      window.location.href = "/register";
      return;
    }
    try {
      const { url } = await api.checkout("monthly");
      window.location.href = url;
    } catch (err) {
      setNotice(
        err instanceof ApiError && err.code === "billing_not_configured"
          ? `Payments aren't wired up on this server yet — ask the admin to enable ${tier.label}.`
          : "Checkout failed — try again shortly."
      );
    }
  }

  return (
    <main className="min-h-screen p-8 max-w-5xl mx-auto">
      <header className="flex items-center gap-4 mb-8">
        <Link href={me ? "/app" : "/"} className="btn">← Back</Link>
        <h1 className="font-display text-3xl font-bold">
          Choose your{" "}
          <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent">
            plan
          </span>
        </h1>
      </header>

      {notice && (
        <p
          className="text-sm text-gold mb-6 cursor-pointer bg-gold/10 border border-gold/30 rounded-lg px-4 py-2"
          onClick={() => setNotice(null)}
        >
          {notice} (dismiss)
        </p>
      )}

      <div className="grid md:grid-cols-3 gap-5">
        {tiers.map((t) => {
          const current = me?.plan === t.id;
          const highlight = t.id === "master";
          return (
            <div
              key={t.id}
              className={`rounded-xl p-6 flex flex-col gap-4 border transition-all duration-150
                ${highlight
                  ? "bg-panelAlt border-accent/60 shadow-glow"
                  : "bg-panelAlt/60 border-white/5"}`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-xl font-bold">{t.label}</h2>
                  {highlight && (
                    <span className="text-[10px] uppercase tracking-wide bg-accent/20 text-accent rounded-full px-2 py-0.5">
                      Best value
                    </span>
                  )}
                  {current && (
                    <span className="text-[10px] uppercase tracking-wide bg-accent2/20 text-accent2 rounded-full px-2 py-0.5">
                      Your plan
                    </span>
                  )}
                </div>
                <p className="mt-2">
                  <span className="font-display text-3xl font-bold">
                    {t.price_monthly === 0 ? "$0" : `$${t.price_monthly}`}
                  </span>
                  <span className="text-muted text-sm"> / month</span>
                </p>
              </div>

              <ul className="space-y-2 text-sm flex-1">
                {features(t).map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-accent">✓</span>
                    <span className={f.includes("coming") ? "text-muted" : ""}>{f}</span>
                  </li>
                ))}
              </ul>

              {t.id === "free" ? (
                <span className="text-center text-xs text-muted py-2">
                  Free forever
                </span>
              ) : current ? (
                <span className="text-center text-xs text-accent2 py-2">
                  Active
                </span>
              ) : (
                <button className="btn-primary w-full" onClick={() => upgrade(t)}>
                  {me ? `Upgrade to ${t.label}` : "Create account"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted mt-8 text-center">
        Paid plans run the newest official Stockfish server-side. The Leela
        engine joins the Master tier once GPU hosting is live — it is listed
        as coming, never sold before it works.
      </p>
    </main>
  );
}
