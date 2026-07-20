# ChessRabbit — Competitive Analysis & v2 Feature Roadmap

*Written July 2026, after the v1 scaffold was completed. Companion to
BLUEPRINT.md, which covers what is already built.*

---

## 1. What ChessRabbit already owns

Every feature proposal below is priced against assets that exist **today**:

| Asset | Where it lives | Why it matters for v2 |
|---|---|---|
| Per-position index of every user game | `game_positions` (zobrist, ply, move) | Personal opening stats are a query, not a project |
| Engine analysis with NAG tags per move | `annotations` (nag, cp_loss, best line) | Every blunder you ever made is already a stored puzzle |
| Spaced-repetition scheduler | `training_cards` (SM-2: ease, interval, due) | Any drillable content can reuse the whole loop |
| Server Stockfish pool + WS streaming | `services/engine`, `/ws/analysis` | Sparring/playing modes need zero new infra |
| Position cache by zobrist | `analysis_cache` | Shared evals across users; deeper = free upgrades |
| Reference DB + opening tree | `games(owner_id NULL)`, `opening_tree` | Master-game features bolt onto the same tables |
| Plans, metering, Stripe mirror | `subscriptions`, `usage_daily` | Any feature can be free-teased / pro-gated in a line |

The strategic read: **ChessRabbit's moat is that the user's own games,
the engine's opinion of them, and a training scheduler live in one
schema.** Every competitor has at most two of the three.

## 2. Competitive landscape (July 2026)

**ChessBase '26 + Mega Database 2026** — the incumbent. 11.7M-game
reference database with ~114k annotated games and weekly updates, remote
engine for premium accounts, new reference filters, Monte-Carlo analysis
(practical winning chances beyond a single eval number), and an AI
"description of plans" feature that they themselves caveat for
hallucinations. Weaknesses unchanged for 25 years: Windows-only desktop,
a-la-carte pricing that stacks into hundreds of euros, and a UI built for
professionals, not improvers. ChessRabbit cannot beat the Mega Database
on size and should not try; it beats the *workflow* (browser, one
subscription, your games first).

**Lichess** — free forever, open source. Studies, a masters + billions-
of-games explorer, puzzles mined from real games. Unbeatable on price;
not trying to be your personal database or a structured improvement
loop. Coexist, integrate (their API is our import source), never fight.

**Chess.com** — owns casual review ("Game Review" with coach-voice
explanations), bots, lessons, and the network. Their weakness is depth:
review is per-game entertainment, not longitudinal ("you have blundered
in 9 of your last 11 Caro-Kanns"). ChessRabbit's insights should always
be *across* games, which their product structure resists.

**Chessable** — owns repertoire training with licensed GM courses and
MoveTrainer spaced repetition. Structural gap: it does not know what you
actually play. Course lines and your real games never meet. ChessRabbit
has both sides of that join.

**Aimchess** — personalized drills from your online games; closest in
spirit, now under the Chess.com umbrella with middling app ratings.
Validates the category.

**CircleChess** — India-based all-in-one (relevant regionally): AI game
review, puzzle generation from your own games, OTB scoresheet upload.
Confirms demand for "your games → your training" and for OTB workflows
in the Indian market.

**DecodeChess / OpeningTree / en-croissant** — single-feature proofs
(natural-language "why", personal opening stats, local open-source GUI)
that each of those features has an audience.

**Positioning statement:** *ChessBase power, Chessable training,
Chess.com clarity — but your own games sit at the center, in a browser,
for one subscription.*

## 3. Feature proposals

Effort estimates assume the current codebase and one developer.

### P0 — Ship within weeks (compound existing tables)

**3.1 Personal Opening Tree** ✅ *shipped* — — the explorer, filtered to *your* games,
with your score per move ("you: 12 games, 33% — masters: 58%") side by
side with the reference column.
*Build:* `owner_id = :user` variant of the existing explorer query plus a
UI toggle. **~1-2 days.** The single highest value-per-line-of-code item
in this document; OpeningTree.com is an entire product doing only this.

**3.2 Puzzles From Your Own Blunders** ✅ *shipped* — — every position where full-game
analysis assigned `??` or `?` becomes a "find the better move" card,
scheduled by the existing SM-2 loop. Chess.com's stickiest improver
feature, generated from data ChessRabbit already stores.
*Build:* query `annotations` for NAG 2/4 with the stored best move,
insert into `training_cards` under an auto-repertoire per user, reuse
`/training/*` wholesale. **~2-3 days.**

**3.3 Lichess & Chess.com Auto-Import** — connect a username; games sync
nightly. Both platforms expose public game-export APIs (no OAuth needed
for public games). This moves the magic moment from "after I upload"
to "immediately after signup".
*Build:* fetch worker + `linked_accounts` table + de-dupe on
(source, source_game_id). **~3-4 days.** Highest onboarding impact.

**3.4 Weekly Insights Email** — accuracy trend, blunder rate by phase,
best/worst openings by score, streaks; one email per week via the
existing mailer.
*Build:* aggregate queries over `annotations` + `games`, a cron entry
next to `purge.py`. **~2 days.** The retention loop.

### P1 — Differentiators (1-2 weeks each)

**3.5 Repertoire Gap Detection** — join your imported games against your
`training_cards`: every position where an opponent left your book, or
where you deviated from your own repertoire, becomes a flagged gap with
one-click "add this branch". **No competitor can build this join**:
Chessable lacks your games, Chess.com lacks your repertoire.
*Build:* zobrist intersection query + a review UI. **~1 week.**

**3.6 Human-Strength Sparring** — "play this position out against a
1600" using Stockfish `UCI_LimitStrength`/`UCI_Elo` over the existing
WebSocket. Pairs naturally with 3.2 (retry your blunder against a fair
opponent) and with the trainer (play the line to move 15, then continue
against the engine).
*Build:* a play-loop mode in the engine worker + board UI state.
**~1 week.**

**3.7 Endgame Drills Judged by Tablebase Truth** — once `SYZYGY_PATH` is
set, serve "only move wins/draws" positions where the judge is DTZ fact,
not engine opinion. Reuses the card scheduler.
*Build:* position miner + `source='tablebase'` cards. **~1 week.**

**3.8 Pawn-Structure Similarity Search** — "show master games with my
structure": hash only the pawn placement (pawn-zobrist) at import, index
it, search the reference DB. A headline ChessBase capability delivered
in a browser.
*Build:* add `pawn_hash BIGINT` to `game_positions`, backfill, one
query + UI panel. **~1 week including backfill.**

### P2 — Bigger bets (3+ weeks, validate first)

**3.9 Plain-Language "Why" Annotations** — LLM turns (eval swing +
refutation line + detected motifs) into two honest sentences per
mistake. ChessBase '26 shipped a version and warns about hallucinations;
the mitigation is grounding: the model only narrates facts the engine
already proved, never evaluates. Pro-only (per-call cost).

**3.10 Shareable Annotated Boards** — public read-only link for a game
with its annotations; the growth surface (every shared link is an ad).

**3.11 Coach Seats** — a coach role linked to student accounts: sees
their games and gaps, assigns repertoires; per-seat Stripe billing
(quantity on the existing subscription). Revenue expansion into the
club/academy market — particularly relevant in India.

**3.12 OTB Scoresheet Photo Import** — OCR of handwritten scoresheets.
Real demand (CircleChess ships it; every OTB tournament player wants
it), but handwriting OCR of chess notation is a genuine ML project.
Park until P0-P1 prove retention.

## 4. Suggested sequencing

```
Sprint 1  (wk 1-2):  3.1 Personal tree + 3.4 Insights email
Sprint 2  (wk 3-4):  3.3 Auto-import + 3.2 Blunder puzzles
   → this four-feature cluster IS the product story:
     "connect your account; ChessRabbit shows where you bleed
      rating and drills exactly that."
Sprint 3  (wk 5-6):  3.5 Gap detection  (the moat feature)
Sprint 4  (wk 7-8):  3.6 Sparring
Then: 3.7 / 3.8 by user demand; P2 only after retention data.
```

Free-vs-Pro mapping: personal tree and 3 blunder-puzzles/day free
(the hook); unlimited puzzles, gap detection, sparring, structure
search, and "why" annotations Pro (the conversion).

## 5. Naming note

"Chess Rabbit" is currently used by a small Chrome Web Store extension
(bot play via the Lozza engine; a hobby project by appearance). This is
unlikely to be a registered trademark, but before spending on branding:
search the trademark registers relevant to your markets (India IP
office, USPTO, EUIPO), and secure the domain and social handles. The
in-code rename is complete either way and trivially repeatable if the
name evolves.
