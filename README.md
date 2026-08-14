# ChessRabbit

A ChessBase-style chess database and analysis platform: game database, server-side
Stockfish analysis, opening explorer, and PGN management — delivered as a web app
with free and Pro subscription tiers.

**Read [`BLUEPRINT.md`](./BLUEPRINT.md) first.** For the complete build status (what we've
done + what's next), see [`docs/BUILD_STATUS.md`](./docs/BUILD_STATUS.md). For what to build next
and how ChessRabbit is positioned against ChessBase, Chessable, and
Chess.com, see [`docs/GROWTH_ROADMAP.md`](./docs/GROWTH_ROADMAP.md). It is the source of truth for
architecture, data model, licensing rules, and the 16-week roadmap. This README
only covers getting the code running.

## Before you deploy this anywhere public

Read [`docs/SECURITY.md`](./docs/SECURITY.md). Two things there are not
optional:

- **Rotate every credential that has ever been in a shell, a file, or this
  repository before the site takes real traffic.** `devpassword`,
  `dev-secret-change-me` and the demo account passwords in
  `pipeline/seed_demo_users.py` are published here, and git keeps whatever was
  committed even after it is edited out — rewriting a file does not rewrite
  history.
- **Never run `pipeline/seed_demo_users.py` against a real database.** It
  creates an admin account whose password is printed in this repository. It
  refuses to run unless `ENVIRONMENT=development` is set explicitly.

## Quickstart (Docker)

```bash
cp .env.example .env
# edit .env: at minimum set JWT_SECRET (openssl rand -hex 32)

docker compose up --build
```

| Service  | URL                        |
|----------|----------------------------|
| Web      | http://localhost:3000      |
| API      | http://localhost:8000      |
| API docs | http://localhost:8000/docs |

The Postgres schema in `db/migrations/` is applied automatically on first boot.

## Quickstart (no Docker)

Terminal 1 — infrastructure:
```bash
# Postgres 16 and Redis 7 running locally, then:
psql -U chessrabbit -d chessrabbit -f db/migrations/001_initial_schema.sql
```

Terminal 2 — API:
```bash
cd apps/api
pip install -r requirements.txt
cp ../../.env.example .env   # adjust DATABASE_URL/REDIS_URL to localhost
uvicorn app.main:app --reload
```

Terminal 3 — engine worker:
```bash
sudo apt install stockfish          # or brew install stockfish
cd services/engine
pip install -r requirements.txt
DATABASE_URL=postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit \
REDIS_URL=redis://localhost:6379/0 python worker.py
```

Terminal 4 — web:
```bash
cd apps/web
npm install
npm run dev
```

## Repository layout

```
BLUEPRINT.md          Product + technical blueprint (read this)
docker-compose.yml    Local dev orchestration (postgres, redis, api, engine, web)
db/migrations/        SQL schema
apps/api/             FastAPI backend (auth, games, analysis, explorer, WS)
apps/web/             Next.js frontend (board workspace, auth pages)
services/engine/      Stockfish worker: Redis queue -> UCI -> pub/sub + cache
pipeline/             Reference-database loader (Lichess CC0 dumps)
.github/workflows/    CI: lint, live engine smoke test, typecheck, build
```

## Populating the opening explorer

**Production:** load real games from the Lichess open database (CC0):

```bash
# Download a monthly dump from https://database.lichess.org
pip install chess "psycopg[binary]" zstandard
python pipeline/load_reference_games.py lichess_db_standard_rated_2024-01.pgn.zst \
    --min-elo 2200 --max-games 200000
```

**Development:** generate realistic seed games in ~2 minutes instead of
downloading gigabytes - Stockfish plays itself from standard opening theory:

```bash
python pipeline/generate_seed_games.py --games 60 --out seed.pgn
python pipeline/load_reference_games.py seed.pgn
```

## Going live with billing

Everything except the Stripe keys already ships. To turn payments on:

1. Create two prices in the Stripe dashboard (Pro monthly, Pro yearly) and
   set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO_MONTHLY`,
   `STRIPE_PRICE_PRO_YEARLY` in `.env`.
2. Add a webhook endpoint pointing at `https://yourdomain/billing/webhook`
   with events: `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`. Copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`.
3. Local testing: `stripe listen --forward-to localhost:8000/billing/webhook`
   and pay with card `4242 4242 4242 4242` in test mode.

Design guarantees (all covered by tests): the plan flip happens only in the
webhook handler, signatures are verified with constant-time HMAC comparison
and a 5-minute tolerance, and every event id is recorded in
`processed_webhook_events` so Stripe's retries can never double-process.

## Licensing rules (do not skip)

- **Stockfish is GPL-3.0** and runs **server-side only**, as an unmodified
  binary in its own process. It is never bundled into the frontend, never
  compiled to WASM, never shipped in any client artifact. This is what keeps
  your application code proprietary. Full reasoning: BLUEPRINT.md Section 3.
- python-chess is GPL-3.0 and is likewise server-side only.
- chess.js (BSD-2) and react-chessboard (MIT) are the only chess code that
  ships to browsers.
- The `/open-source` API endpoint serves the attribution page required at launch.
- "ChessBase" is someone else's trademark. Do not use it in product names or
  marketing copy.

## Current state

Working today (all covered by tests that ran against live services):

- Auth: register, login, rotating refresh tokens, logout, email verification,
  **password reset** (enumeration-safe, single-use tokens, revokes all sessions),
  **resend verification**, **rate limiting** on auth endpoints (Redis fixed-window)
- Email: provider-agnostic mailer (`app/services/mailer.py`) - console backend
  in dev, Resend-compatible HTTP backend when EMAIL_API_KEY is set
- Games: PGN import (multi-game), listing, detail, delete, annotations, collections
- Analysis: position analysis via queue -> Stockfish -> Redis pub/sub -> cache;
  cache hits answer in ~10ms; free-tier depth/multipv clamping; daily metering
- Full-game annotation: blunder tagging (?!/?/??) + accuracy scores (Pro)
- Live analysis WebSocket with progressive depth streaming
- Opening explorer + position search over the reference database
- **Personal Opening Tree**: the explorer's "My games" scope shows your
  own move statistics beside the master reference (Sprint 1 of
  docs/GROWTH_ROADMAP.md)
- **Blunder puzzles**: every engine-tagged ? / ?? from full-game analysis
  becomes a spaced-repetition card ("My Blunders" auto-repertoires); the
  stored engine-best move is the expected answer, judged server-side
- **Repertoire trainer**: create repertoires from PGNs with variations
  (opponent branches expand, transpositions dedupe on zobrist); SM-2-lite
  spaced repetition; answers judged server-side
- **Quick wins**: per-game PGN export (round-trip safe), game search filters
  (player/result/ECO), batch collection analysis (Pro, 25-game cap)
- Seed tooling: `pipeline/generate_seed_games.py` fills the explorer with
  engine self-play from standard theory for dev environments
- **Billing (Stripe)**: checkout + customer-portal endpoints, and a webhook
  handler that mirrors subscription state and flips free/pro - signature
  verification, idempotency, and the full lifecycle (checkout -> past_due ->
  recovered -> canceled) are integration-tested with self-signed events
- **Admin**: `/admin/stats` (users, games, queue depth, engine seconds,
  DB size), user roster with usage, suspend/unsuspend (blocks tokens AND
  logins); bootstrap with `python pipeline/make_admin.py you@example.com`
- **Endgame tablebases**: `/analysis/tablebase` gives exact results -
  rule-based draws work out of the box; download Syzygy 3-4-5 files and set
  SYZYGY_PATH for full WDL/DTZ probing
- Responsive board: fits phone screens via min(92vw, 480px) sizing
- Maintenance: `pipeline/purge.py` hard-deletes accounts past the 30-day
  retention window and sweeps expired tokens (run nightly from cron)
- Web: landing, auth pages (incl. forgot/reset/verify), board workspace with
  eval bar, engine pane, move list, keyboard navigation, PGN import, explorer

The 16-week blueprint roadmap is fully scaffolded. What remains is
operational, not code: real Stripe keys, real Lichess data, Syzygy files,
an email provider key, and a server to deploy on.
