# ChessBase-Style Platform — Complete Build Blueprint

**Codename:** "ChessRabbit" (rename as you like)
**Model:** Web-based chess database + analysis platform, subscription (SaaS), Stockfish running **server-side only**.
**Audience for this document:** Any developer or AI assistant. Every section is self-contained enough to hand to Claude as a build task.

---

## 0. How to use this blueprint with an AI assistant

Build in the phase order given in Section 15. For each phase, paste the relevant sections into Claude and say, for example:

> "Here is Section 7 (data model) and Section 8 (API spec) of my blueprint. Implement the `games` and `analysis_cache` tables as SQL migrations, then the `/games` endpoints in FastAPI, with tests."

Rules of engagement:
1. Never let the AI (or yourself) change the licensing architecture in Section 3 without re-reading it.
2. Keep this file in the repo root as `BLUEPRINT.md` — it is the single source of truth.
3. When a decision in this document conflicts with convenience, the document wins until you consciously amend it.

---

## 1. Product definition

### 1.1 What we are building
A chess study platform combining the three pillars of ChessBase:

1. **Database** — store, import, search, and browse large collections of chess games (your own games + a public reference database of millions of games).
2. **Engine analysis** — Stockfish evaluation of any position, live analysis while you move pieces, and automatic full-game annotation (blunder detection, accuracy score).
3. **Opening preparation** — an opening explorer (tree of moves with statistics: how often each move is played and how it scores) built from the reference database.

### 1.2 What we are NOT building (v1)
- Playing chess online against other humans (that's Lichess/Chess.com — a different, harder product).
- Video courses / e-learning content.
- Native desktop engine bundling (see Section 3 for why).
- Mobile native apps (a responsive web app first; wrap later with Tauri/Capacitor if wanted).

### 1.3 Target users
Club players (1200–2200 Elo) who want ChessBase-style prep without the €150+ price tag or Windows requirement. They prepare openings, review their own games, and study master games.

### 1.4 Business model
| Tier | Price | What it unlocks |
|---|---|---|
| Free | $0 | Board + import own games (max 50 stored), engine analysis to depth 18, 10 analyses/day, browse reference DB |
| Pro | $6/mo or $48/yr | Unlimited stored games, depth 30+ analysis, MultiPV 5 lines, full-game auto-annotation, opening explorer filters (Elo range, date), PGN export of anything, priority engine queue |

One paid tier at launch. Add a "Team/Coach" tier later only if demanded.

---

## 2. Complete feature specification

### 2.1 MVP (launch scope)

**Board & game viewing**
- Interactive board: drag/tap moves, legal-move validation, flip board, piece animation.
- Move list with variations (tree, not just a flat list), navigate with arrow keys/swipe.
- NAG symbols (!, ?, !?, ?!, ??, !!) and text comments on any move.
- FEN input/output; copy position; set up arbitrary positions (with legality check).

**Game management**
- Import PGN: paste text, upload file (multi-game files supported, up to 10 MB free / 200 MB pro).
- Export PGN (single game or collection).
- Personal collections (folders): create, rename, move games between them.
- Game metadata editing (players, event, date, result, Elo).

**Engine analysis (server-side Stockfish)**
- "Analyze" toggle on any position: streams evaluation, depth, best line(s) live over WebSocket.
- Eval bar next to the board.
- MultiPV (1 line free, up to 5 pro).
- Full-game analysis job (pro): every move evaluated, blunders/mistakes/inaccuracies flagged, per-player accuracy %, results stored as annotations.
- Analysis cache: identical positions are never computed twice (see 9.4).

**Reference database**
- Preloaded public database (Lichess CC0 dumps, filtered to ≥2200 Elo rated games — a few million games; see 10.1).
- Search by player name, ECO code, opening name, result, Elo range, date range.
- **Position search**: "find all games that reached this exact position" (see 10.3).

**Opening explorer**
- From any position ≤ move 15: table of moves played, game counts, White/Draw/Black percentages, average Elo, sample games list.
- Click a move to descend the tree.

**Accounts & billing**
- Email + password auth (JWT), email verification, password reset.
- Stripe Checkout subscription, customer portal for cancel/upgrade, webhook-driven entitlement.

### 2.2 Post-launch (v1.x)
- Repertoire builder: mark "my move" per position, spaced-repetition drilling of your repertoire.
- Compare-with-explorer during analysis ("book until move 9, novelty at move 10").
- Import games automatically from Lichess/Chess.com accounts via their public APIs.
- Shareable read-only game links.
- Engine play ("play vs computer at ~1500 Elo") using `UCI_LimitStrength`.

### 2.3 Explicit non-goals until product-market fit
Cloud engine racing (multiple engines), DGT board support, tablebases (add Syzygy probing later — it's a bounded feature), video, forums.

---

## 3. Legal & licensing architecture — READ BEFORE CODING

This section exists because one wrong dependency can legally force you to open-source your entire product.

### 3.1 The Stockfish rule
Stockfish is **GPL-3.0**. GPL obligations trigger on **distribution** of the program, not on running it.

- **Our architecture: Stockfish runs only on our servers.** Users send positions over the network and receive evaluations. We never ship the Stockfish binary to users. → **No obligation to open-source anything.** (GPL-3 is not AGPL-3; network use is not distribution.)
- We still act in good faith: the site footer and an `/open-source` page credit Stockfish, link to its source, and state the version we run.
- **Never** compile Stockfish to WASM and ship it in the browser, and **never** bundle it in a desktop build, without re-reading this section. Distributing it is legal *only if* you provide the GPL license text and its complete corresponding source (a link to the exact version's source suffices), and your own code remains separate (communicating with an unmodified engine binary as a separate process over UCI text pipes is the classic "mere aggregation" pattern used by GUIs like Arena). It is doable, but the clean, zero-risk path is server-side, so that is the blueprint's decision.
- **Never modify Stockfish source.** Use official releases. Modification + distribution = your modifications must be GPL'd; modification + server-only = still fine, but pointless risk.

### 3.2 Dependency license table (enforce in code review)
| Component | License | Client (shipped to user) | Server-only | Verdict |
|---|---|---|---|---|
| Stockfish | GPL-3.0 | ❌ never | ✅ | Server only |
| chess.js (rules, PGN/FEN) | BSD-2-Clause | ✅ | ✅ | Use everywhere |
| react-chessboard | MIT | ✅ | — | Use for the board UI |
| chessground (Lichess board) | GPL-3.0 | ❌ | — | Do NOT use |
| chessops / lila code | GPL/AGPL | ❌ | ❌ | Never copy anything from Lichess repos |
| python-chess (server PGN pipeline) | GPL-3.0 | ❌ | ✅ (not distributed) | OK server-side |
| Lichess game database dumps | CC0 (public domain) | ✅ | ✅ | Free to use commercially |
| lichess-org/chess-openings (ECO names) | CC0 — verify at time of use | ✅ | ✅ | Use for opening names |
| Piece/board graphics | varies | ⚠️ | — | Verify each set's license; many popular sets are CC-BY-SA or GPL. Safest: buy/commission a piece set, or use a clearly MIT/CC0 set with attribution kept in credits. |
| Syzygy tablebase files (later) | see source | — | ✅ | Server-side probing only |

**Policy:** every new dependency gets its license checked and added to this table before `npm install`/`pip install`. Anything GPL/AGPL is server-side-only by default; anything shipped to the browser must be MIT/BSD/Apache-2.0/CC0.

### 3.3 Other legal items
- Terms of Service + Privacy Policy before charging money (template from a generator is fine to start; lawyer review when revenue justifies it).
- GDPR basics: data export + account deletion endpoints (Section 8 includes them).
- Stripe handles card data — you never store card numbers (keeps you out of most PCI scope).
- Trademark: do not use "ChessBase" in your name, marketing, or ads.

---

## 4. System architecture

```
                        ┌────────────────────────────┐
                        │        Browser (SPA)       │
                        │  Next.js + react-chessboard│
                        │  chess.js (rules, PGN)     │
                        └───────┬───────────┬────────┘
                                │ HTTPS/REST│ WebSocket (analysis stream)
                                ▼           ▼
                        ┌────────────────────────────┐
                        │       API Gateway/App      │
                        │  FastAPI (Python 3.12)     │
                        │  auth · games · search ·   │
                        │  billing · explorer        │
                        └──┬───────┬───────┬─────────┘
                           │       │       │
             ┌─────────────┘       │       └───────────────┐
             ▼                     ▼                       ▼
   ┌──────────────────┐   ┌──────────────┐        ┌────────────────┐
   │   PostgreSQL 16  │   │   Redis 7    │        │ Stripe (SaaS)  │
   │ users, games,    │   │ job queue,   │        │ checkout,      │
   │ positions, cache,│   │ pub/sub for  │        │ webhooks       │
   │ opening_tree     │   │ eval streams,│        └────────────────┘
   └──────────────────┘   │ rate limits  │
             ▲            └──────┬───────┘
             │                   │ pops jobs / publishes eval lines
             │                   ▼
   ┌─────────┴──────────────────────────────┐
   │           Engine Service               │
   │  Python supervisor managing a pool of  │
   │  N Stockfish processes (UCI via stdio) │
   │  · per-job depth/time caps by tier     │
   │  · writes results to analysis_cache    │
   └────────────────────────────────────────┘
```

Key decisions:
1. **The browser knows chess rules** (chess.js) so the UI is instant; **the server re-validates everything** (never trust the client).
2. **Engine workers are stateless consumers** of a Redis queue → scale by adding worker containers/machines; the API never blocks on analysis.
3. **Every evaluation is cached by position** → over time, popular positions cost you $0 to "analyze".
4. All components run from one `docker-compose.yml` in development and on a single VPS at launch; the queue architecture lets you split engine workers onto separate machines when load demands, with zero code change.

---

## 5. Tech stack (concrete)

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js 14 (React, TypeScript)** | SSR for public game pages (SEO), huge ecosystem, Claude writes it well |
| Board UI | **react-chessboard** (MIT) | Drag-drop, arrows, customizable |
| Client chess logic | **chess.js** (BSD) | Legal moves, FEN/PGN, check/checkmate detection |
| Styling | Tailwind CSS | Fast iteration |
| API | **FastAPI (Python 3.12) + Uvicorn** | Async, WebSockets, Pydantic validation, easy Stockfish subprocess control; python-chess for server-side PGN/FEN handling |
| DB | **PostgreSQL 16** | Relational + JSONB for annotations; handles position index at our scale |
| Queue / cache / pubsub | **Redis 7** (+ `arq` or `rq` for jobs) | One dependency does jobs, streams, and rate-limiting |
| Engine | **Stockfish latest official release** (server-only) | Strongest free engine |
| Auth | JWT (access 15 min + refresh 30 days), `argon2` password hashing | Standard |
| Payments | **Stripe** Checkout + Billing portal + webhooks | Fastest correct path |
| Email | Resend or Postmark (verification, receipts) | Cheap, reliable |
| Infra | Docker Compose → **Hetzner** CPX/CCX VPS, Caddy (auto-HTTPS) | Best CPU per dollar for engines |
| CI/CD | GitHub Actions: test → build images → SSH deploy | Simple |
| Monitoring | Sentry (errors) + Uptime Kuma + basic Grafana/Prometheus later | Enough at launch |

Alternative stack note: if you prefer one language everywhere, Node/NestJS + TypeScript works identically; keep python-chess-equivalent logic via chess.js server-side. The architecture is language-agnostic — do not let the AI switch languages mid-project.

### 5.1 Repository layout (monorepo)
```
chessrabbit/
├── BLUEPRINT.md                  # this file
├── docker-compose.yml            # dev: web, api, worker, postgres, redis
├── infra/
│   ├── Caddyfile
│   └── deploy.md                 # runbook: how to deploy, rollback, backup
├── apps/
│   ├── web/                      # Next.js app
│   │   └── src/{app,components,lib,hooks}
│   └── api/                      # FastAPI app
│       └── app/
│           ├── main.py
│           ├── routers/ {auth,games,search,analysis,explorer,billing,users}.py
│           ├── models/           # SQLAlchemy models
│           ├── schemas/          # Pydantic schemas
│           ├── services/         # business logic
│           └── ws/analysis.py    # WebSocket endpoint
├── services/
│   └── engine/
│       ├── worker.py             # queue consumer
│       ├── uci.py                # Stockfish process wrapper
│       └── Dockerfile            # installs stockfish binary
├── pipeline/                     # one-off & scheduled data jobs
│   ├── import_lichess.py         # bulk PGN → games/positions tables
│   └── build_opening_tree.py
├── db/migrations/                # Alembic
└── .env.example
```

### 5.2 Environment variables (.env.example)
```
DATABASE_URL=postgresql://chessrabbit:pass@postgres:5432/chessrabbit
REDIS_URL=redis://redis:6379/0
JWT_SECRET=change-me-64-random-chars
ACCESS_TOKEN_TTL_MIN=15
REFRESH_TOKEN_TTL_DAYS=30
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
EMAIL_API_KEY=...
APP_BASE_URL=https://yourdomain.com
ENGINE_WORKERS=3                  # stockfish processes per worker container
ENGINE_THREADS_PER_JOB=2
ENGINE_HASH_MB=256
FREE_MAX_DEPTH=18
PRO_MAX_DEPTH=32
FREE_DAILY_ANALYSES=10
```

---

## 6. Chess data formats (glossary you will actually need)

- **FEN** — one-line text snapshot of a position: `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1` (pieces / side to move / castling rights / en-passant square / halfmove clock / move number).
- **PGN** — text format for whole games: tag pairs (`[White "Carlsen, M"]`) + movetext (`1. e4 e5 2. Nf3 ...`), supports `{comments}`, `(variations)`, and `$n` NAGs.
- **UCI** — the text protocol engines speak over stdin/stdout (Section 9.1).
- **Ply** — one half-move (White's move = 1 ply; a full move = 2 plies).
- **Centipawn (cp)** — engine eval unit; +100 ≈ White is a pawn up. `mate N` = forced mate in N.
- **MultiPV** — engine reports its top-N candidate moves, not just the best.
- **Zobrist hash** — 64-bit fingerprint of a position; two identical positions always share it. Our position search key. (python-chess can compute a stable polyglot Zobrist.)
- **ECO code** — opening classification A00–E99 (e.g., B90 = Najdorf).
- **NAG** — Numeric Annotation Glyph (`$2` = `?`, `$4` = `??`, etc.).

---

## 7. Data model (PostgreSQL)

```sql
-- 7.1 users & auth
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,               -- argon2id
  display_name  TEXT NOT NULL DEFAULT '',
  plan          TEXT NOT NULL DEFAULT 'free',-- 'free' | 'pro'
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ                  -- soft delete for GDPR flow
);

CREATE TABLE refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT FALSE
);

-- 7.2 billing (mirror of Stripe truth)
CREATE TABLE subscriptions (
  id                     BIGSERIAL PRIMARY KEY,
  user_id                BIGINT NOT NULL UNIQUE REFERENCES users(id),
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL,      -- active|trialing|past_due|canceled|...
  current_period_end     TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7.3 games (user games AND the reference database in one table)
CREATE TABLE games (
  id          BIGSERIAL PRIMARY KEY,
  owner_id    BIGINT REFERENCES users(id),   -- NULL = public reference game
  source      TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'lichess' | ...
  white       TEXT NOT NULL DEFAULT '',
  black       TEXT NOT NULL DEFAULT '',
  white_elo   SMALLINT,
  black_elo   SMALLINT,
  result      TEXT NOT NULL DEFAULT '*',     -- '1-0' '0-1' '1/2-1/2' '*'
  event       TEXT NOT NULL DEFAULT '',
  site        TEXT NOT NULL DEFAULT '',
  played_on   DATE,
  eco         CHAR(3),
  opening     TEXT,
  ply_count   SMALLINT NOT NULL DEFAULT 0,
  movetext    TEXT NOT NULL,                 -- SAN movetext, no headers
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX games_owner_idx   ON games(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX games_white_idx   ON games (lower(white) text_pattern_ops) WHERE owner_id IS NULL;
CREATE INDEX games_black_idx   ON games (lower(black) text_pattern_ops) WHERE owner_id IS NULL;
CREATE INDEX games_eco_idx     ON games(eco)        WHERE owner_id IS NULL;
CREATE INDEX games_elo_idx     ON games(GREATEST(white_elo,black_elo)) WHERE owner_id IS NULL;

-- 7.4 position index (powers position search + opening explorer)
-- One row per position reached in a reference game, up to ply 40 (cap controls size).
CREATE TABLE game_positions (
  game_id   BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply       SMALLINT NOT NULL,               -- position BEFORE this ply's move
  zobrist   BIGINT NOT NULL,                 -- polyglot zobrist of the position
  move_uci  TEXT NOT NULL,                   -- move played from this position
  PRIMARY KEY (game_id, ply)
);
CREATE INDEX game_positions_zobrist_idx ON game_positions(zobrist);
-- Size math: 3M games × ~40 rows ≈ 120M rows ≈ 8–12 GB with index. Fine on one box.
-- If you later ingest 100M games, partition by zobrist range or move to ClickHouse.

-- 7.5 precomputed opening explorer (rebuilt by batch job, Section 10.4)
CREATE TABLE opening_tree (
  zobrist     BIGINT NOT NULL,
  move_uci    TEXT   NOT NULL,
  games       INT    NOT NULL,
  white_wins  INT    NOT NULL,
  draws       INT    NOT NULL,
  black_wins  INT    NOT NULL,
  avg_elo     SMALLINT,
  PRIMARY KEY (zobrist, move_uci)
);

-- 7.6 engine cache & jobs
CREATE TABLE analysis_cache (
  zobrist        BIGINT NOT NULL,
  fen            TEXT NOT NULL,              -- verification against hash collision
  engine_version TEXT NOT NULL,
  depth          SMALLINT NOT NULL,
  multipv        JSONB NOT NULL,             -- [{move, cp|mate, pv:[...]}, ...]
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (zobrist, engine_version)
);
-- Overwrite row only when new depth > stored depth.

CREATE TABLE analysis_jobs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  game_id     BIGINT REFERENCES games(id),
  kind        TEXT NOT NULL,                 -- 'position' | 'full_game'
  params      JSONB NOT NULL,                -- {fen?, depth, multipv}
  status      TEXT NOT NULL DEFAULT 'queued',-- queued|running|done|failed|canceled
  result      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- 7.7 annotations & collections
CREATE TABLE annotations (
  id       BIGSERIAL PRIMARY KEY,
  game_id  BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id  BIGINT NOT NULL REFERENCES users(id),
  ply      SMALLINT NOT NULL,
  nag      SMALLINT,                          -- 1..6 etc.
  comment  TEXT,
  eval_cp  INT,                               -- filled by full-game analysis
  UNIQUE (game_id, user_id, ply)
);

CREATE TABLE collections (
  id      BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL
);
CREATE TABLE collection_games (
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  game_id       BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, game_id)
);

-- 7.8 usage metering (free-tier limits)
CREATE TABLE usage_daily (
  user_id  BIGINT NOT NULL REFERENCES users(id),
  day      DATE   NOT NULL,
  analyses INT    NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
```

---

## 8. API specification (FastAPI)

All responses JSON. Auth via `Authorization: Bearer <access_token>` unless marked public. Errors: `{"error": {"code": "string", "message": "human text"}}` with proper HTTP status.

### 8.1 Auth
| Method | Path | Body → Result |
|---|---|---|
| POST | `/auth/register` | {email, password} → sends verification email |
| POST | `/auth/verify` | {token} → email_verified=true |
| POST | `/auth/login` | {email, password} → {access, refresh} |
| POST | `/auth/refresh` | {refresh} → new pair (rotate refresh token) |
| POST | `/auth/logout` | revoke refresh token |
| POST | `/auth/forgot` / `/auth/reset` | standard reset flow |

### 8.2 Users
| GET | `/me` | profile + plan + usage today |
| PATCH | `/me` | display_name |
| GET | `/me/export` | ZIP: all games as PGN + JSON of account data (GDPR) |
| DELETE | `/me` | soft-delete account, cancel Stripe sub |

### 8.3 Games & collections
| GET | `/games?collection=&q=&page=` | list own games |
| POST | `/games` | {pgn} single game → parsed, stored (free-tier count check) |
| POST | `/games/import` | multipart PGN file, multi-game; returns {imported, skipped, errors[]} — processed as a job if > 500 games |
| GET | `/games/{id}` | headers + movetext + annotations (owner or public) |
| PATCH | `/games/{id}` | edit metadata |
| DELETE | `/games/{id}` | delete own game |
| GET | `/games/{id}/pgn` | export with annotations merged (pro for reference games) |
| POST/GET/PATCH/DELETE | `/collections...` | CRUD + add/remove games |
| PUT | `/games/{id}/annotations` | bulk upsert [{ply, nag?, comment?}] |

### 8.4 Search (reference DB, public with rate limit; filters beyond basics = pro)
| GET | `/search/games?white=&black=&eco=&opening=&result=&min_elo=&from=&to=&page=` |
| POST | `/search/position` | {fen} → server computes zobrist → games list (max page 50) |

### 8.5 Opening explorer
| POST | `/explorer` | {fen, min_elo?, speeds? } → {moves: [{uci, san, games, white, draws, black, avg_elo}], top_games: [...]} — straight read of `opening_tree` |

### 8.6 Analysis
| POST | `/analysis/position` | {fen, depth?, multipv?} → cache hit ⇒ instant result; miss ⇒ {job_id} (then use WS) — enforces tier caps + daily meter |
| POST | `/analysis/game/{game_id}` | pro; queues full-game annotation job → {job_id} |
| GET | `/analysis/jobs/{id}` | status/result |
| DELETE | `/analysis/jobs/{id}` | cancel |

### 8.7 WebSocket `/ws/analysis?token=...`
Client → server messages:
```json
{"op":"start","fen":"...","multipv":3}     // live/infinite analysis of a position
{"op":"stop"}
{"op":"subscribe","job_id":123}            // watch a queued job
```
Server → client stream (relayed from Redis pub/sub channel `eval:{job_id}`):
```json
{"type":"info","depth":17,"multipv":1,"cp":34,"mate":null,"pv":["e2e4","e7e5","g1f3"]}
{"type":"done","best":"e2e4","final":{...}}
{"type":"error","code":"depth_cap","message":"Upgrade for deeper analysis"}
```
Rules: one live analysis per free user, three per pro user; server auto-stops live analysis after 90 s free / 10 min pro; every `info` at a "checkpoint depth" (12, 18, 24, 30) upserts `analysis_cache`.

### 8.8 Billing
| POST | `/billing/checkout` | {price_id} → Stripe Checkout URL |
| POST | `/billing/portal` | → Stripe customer portal URL |
| POST | `/webhooks/stripe` | public; verify signature; handle `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` → update `subscriptions` + `users.plan`. Idempotent by event id. Nightly reconciliation job re-syncs any `past_due` accounts. |

---

## 9. Engine service (the heart of the product)

### 9.1 UCI in 60 seconds
Stockfish is a console program. You write lines to stdin, read lines from stdout:

```
→ uci
← id name Stockfish 17 ... uciok
→ setoption name Threads value 2
→ setoption name Hash value 256
→ setoption name MultiPV value 3
→ ucinewgame
→ position fen r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3
→ go depth 24
← info depth 24 seldepth 31 multipv 1 score cp 31 nodes 8123456 pv f1b5 a7a6 ...
← info depth 24 multipv 2 score cp 22 pv b1c3 ...
← bestmove f1b5 ponder a7a6
```
`score cp 31` = +0.31 for the side to move (normalize to White's perspective before storing: negate when Black to move). `score mate 5` = forced mate in 5. For live analysis use `go infinite` and later send `stop`.

### 9.2 Worker design (`services/engine/worker.py`)
- On boot: spawn `ENGINE_WORKERS` Stockfish processes; handshake `uci`/`isready`; each worker loops on the Redis queue (`arq`).
- Job = `{job_id, fen, depth, multipv, movetime_ms?, publish_channel}`.
- Steps: check `analysis_cache` (≥ requested depth ⇒ publish cached result, done) → run engine → publish each `info` line parsed to JSON on `eval:{job_id}` → on `bestmove`, upsert cache, mark job done.
- Hard limits per job: `movetime` ceiling (e.g., 60 s), kill + respawn engine on timeout/crash (engines do crash; supervisors must be boring and ruthless).
- Priority queues: `q:pro` drained before `q:free`.
- Live (infinite) analysis: the WS handler owns a dedicated engine slot; a `stop` op or disconnect sends UCI `stop` and frees the slot.

### 9.3 Full-game annotation algorithm (pro feature)
```
for each position P_i in game (i = 0..N):
    eval_i = cached_or_compute(P_i, depth=20)      # White-perspective cp; mate = ±10000∓ply
for each move m_i (from P_i to P_i+1):
    loss = (eval_i - eval_{i+1}) for White's moves, reversed for Black
    tag:  loss ≥ 200 → "??" blunder  | ≥ 100 → "?" | ≥ 50 → "?!"
    store annotations rows (nag + eval_cp)
accuracy: convert each eval to win% with the standard logistic mapping
    win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
    per-move accuracy from win% drop; game accuracy = harmonic-style mean (Lichess-published formula family — implement once, unit-test against hand-checked games)
```
Cost control: depth 20 fixed, cache first, skip book moves (first 8 plies found in `opening_tree` with ≥ 1000 games).

### 9.4 Why the cache wins
1. e4 e5 Nf3 appears in millions of user games. After a month, >60% of requested positions are cache hits (top-of-book positions especially), so marginal analysis cost trends toward zero. Never bypass the cache except when a user explicitly requests deeper analysis than stored.

---

## 10. Reference database & opening explorer

### 10.1 Data source
Lichess publishes complete monthly game dumps under **CC0** at database.lichess.org (`.pgn.zst`, billions of games). Ingest policy for quality + size: rated games, both players ≥ 2200, Blitz/Rapid/Classical, last ~10 years → roughly 3–5M games. Later add elite/OTB PGN sources — verify each source's license before ingesting.

### 10.2 Import pipeline (`pipeline/import_lichess.py`)
Stream-decompress (`zstandard`), parse incrementally with python-chess, filter, then per game: insert `games` row; replay moves; for ply ≤ 40 insert `(game_id, ply, zobrist, move_uci)` rows (batch `COPY`, 5k games/commit). Assign ECO/opening name by longest-prefix match against the CC0 openings dataset loaded into an in-memory dict. Runs for hours — resumable by file offset checkpoint. Same parser handles user PGN imports (with a 5 MB in-request cap; larger files become jobs).

### 10.3 Position search
```sql
SELECT g.* FROM game_positions p
JOIN games g ON g.id = p.game_id
WHERE p.zobrist = $1 AND g.owner_id IS NULL
ORDER BY GREATEST(g.white_elo, g.black_elo) DESC NULLS LAST
LIMIT 50 OFFSET $2;
```
On the 1-in-billions chance of a hash collision, verify by replaying the game server-side before display (cheap at LIMIT 50).

### 10.4 Opening tree build (`pipeline/build_opening_tree.py`)
```sql
INSERT INTO opening_tree
SELECT p.zobrist, p.move_uci, count(*),
       count(*) FILTER (WHERE g.result='1-0'),
       count(*) FILTER (WHERE g.result='1/2-1/2'),
       count(*) FILTER (WHERE g.result='0-1'),
       avg((g.white_elo+g.black_elo)/2)::smallint
FROM game_positions p JOIN games g ON g.id=p.game_id
WHERE g.owner_id IS NULL AND p.ply <= 30
GROUP BY 1,2;
```
Rebuild into a shadow table, then atomic rename-swap. Re-run monthly when you ingest a new dump. `/explorer` is then a single indexed read — no live aggregation.

---

## 11. Client application design (Next.js)

### 11.1 Pages
| Route | Purpose |
|---|---|
| `/` | Landing: pitch, pricing, demo board |
| `/app` | Dashboard: recent games, collections, "analyze a position" quick box |
| `/app/board` | **The workspace** (11.2) |
| `/app/games` | Own DB: table, filters, import button (drag-drop PGN) |
| `/app/game/[id]` | Game view = workspace preloaded with that game |
| `/app/search` | Reference DB search + position search tab |
| `/app/explorer` | Opening explorer full-page (board left, tree right) |
| `/app/settings` | Profile, board theme, billing portal link |
| `/pricing`, `/login`, `/register`, `/open-source` | plus ToS/Privacy |

### 11.2 The workspace (single most important screen)
Layout desktop: board left (60%); right column tabs: **Notation** (move tree with variations, click to jump), **Engine** (toggle, eval bar, N best lines updating live, depth indicator, "add line to notation" button), **Explorer** (tree for current position), **Info** (headers, edit). Mobile: board on top, tabs below, swipe between moves. Keyboard: ←/→ moves, ↑/↓ variations, F flip, Space engine toggle.

State: `chess.js` instance is the source of truth; a `GameTree` structure (nodes: {san, uci, fen, zobrist, children[], nag?, comment?}) supports variations; WS hook `useEngine(fen)` streams evals; every position change triggers explorer fetch (debounced 300 ms, cached client-side).

### 11.3 UX guardrails
Free user hits a cap → inline upgrade prompt exactly where the value was denied (depth slider locks past 18 with a lock icon). Never dark-pattern: show remaining daily analyses openly.

---

## 12. Security & abuse prevention
1. Argon2id password hashing; JWT short-lived; refresh rotation with reuse detection.
2. Rate limits (Redis): auth endpoints 5/min/IP; search 60/min/user; analysis via metering table; WS message rate cap.
3. Validate every FEN/PGN server-side with python-chess; reject illegal positions (engines can crash on garbage). Parse PGN with size + depth limits (variation bombs).
4. Engine isolation: workers run in their own container, no DB write access except cache/jobs tables via the API of the queue result — least privilege DB roles per service.
5. Stripe webhook signature verification; never trust client-reported plan — read from DB on every request (middleware attaches `plan`).
6. HTTPS everywhere (Caddy), HSTS, secure cookies for refresh token (httpOnly) if you use cookie flow.
7. Backups: nightly `pg_dump` to object storage (Hetzner Storage Box / B2), 14-day retention, **restore drill once before launch**.
8. Logging: structured JSON, no passwords/tokens; Sentry on API + web.

---

## 13. Testing strategy
- **Unit**: PGN parser round-trips (import → export identical); zobrist stability fixtures; eval-normalization (White perspective) tests; accuracy formula against 3 hand-checked games.
- **Engine service**: golden test — position with known best move at depth 12 (e.g., mate-in-2 puzzles) must return that move; timeout/crash-respawn test with a killed process.
- **API**: pytest + httpx against a dockerized Postgres; auth flows; tier-gating matrix (free vs pro on every capped endpoint); Stripe webhooks with the Stripe CLI in test mode.
- **E2E**: Playwright — register → import PGN → make moves → run analysis → see eval bar → subscribe (Stripe test card 4242...) → depth 30 unlocked.
- **Load**: k6 script — 50 concurrent live analyses; confirm queue degrades gracefully (waits, not crashes).
- CI runs unit+API on every PR; E2E nightly.

---

## 14. Infrastructure & deployment
- **Launch box**: Hetzner CCX33 (8 dedicated vCPU / 32 GB, ~€50/mo): runs everything. Engine workers pinned to 4–6 cores (each job: Threads=2, Hash=256 MB ⇒ 2–3 concurrent deep analyses; queue absorbs bursts).
- **Scale path** (no code changes): move Postgres to its own node or managed; add engine-only worker nodes pointing at the same Redis (`docker compose --profile worker up` on each). 10 engine nodes ≈ €400/mo serves thousands of subscribers.
- Deploy: GitHub Actions builds images → `docker compose pull && up -d` over SSH; migrations via Alembic on release; blue-green not needed at this scale — 10 s of downtime at 4 a.m. is fine.
- Runbook `infra/deploy.md` documents: deploy, rollback (previous image tag), restore-from-backup, rotate secrets.

---

## 15. Development roadmap (solo dev + Claude, full-time)

| Phase | Weeks | Deliverable — definition of done |
|---|---|---|
| 0. Foundation | 1 | Repo, docker-compose (all services boot), CI green, auth end-to-end incl. email verify |
| 1. Board & games | 2–4 | Workspace with move tree + variations; PGN import/export round-trip; collections; deployed to the VPS behind HTTPS |
| 2. Engine | 5–7 | Live WS analysis with eval bar + MultiPV; cache working (verify by re-analyzing = instant); full-game annotation job with NAGs + accuracy |
| 3. Reference DB | 8–10 | 3M+ games imported; metadata search; position search; opening explorer tab live |
| 4. Monetization | 11–12 | Stripe subscribe/cancel; every gate in the tier table enforced + tested; usage metering |
| 5. Hardening & beta | 13–14 | Rate limits, backups+restore drill, Sentry, ToS/Privacy, landing page; 10–20 beta users invited |
| 6. Launch | 15–16 | Fix beta findings; public launch (r/chess, Discords, HN Show) |

Reality check: this assumes full-time focus and experience shipping web apps with AI assistance. Part-time (evenings), double it: **6–8 months**. "A few days" is enough for a toy board with engine output — not for a product people pay for. v1.x items (repertoire trainer, Lichess account sync) follow launch based on user demand.

---

## 16. Cost breakdown

**Build (pre-revenue):** Claude Pro $20/mo; domain ~$12/yr; Hetzner dev/prod box €50/mo from Phase 1; email free tier; Stripe $0 until sales. → **≈ $80–90/month, ~$350 total to launch.** Your time is the real investment.

**Running at ~200 Pro subscribers (~$1,200 MRR):** VPS + 1 extra worker node ≈ €90; managed Postgres or bigger box ≈ €25; email ≈ $10; backups ≈ $5; Stripe fees ≈ 3.2% ≈ $40; Sentry free tier. → **≈ $180/mo, gross margin ~85%.**

**Stockfish royalty: $0 forever** — provided the Section 3 architecture is respected.

---

## 17. Launch checklist
- [ ] `/open-source` credits page: Stockfish (version + source link), chess.js, react-chessboard, Lichess database (CC0), openings dataset, piece-set license/attribution
- [ ] ToS + Privacy published; refund policy stated (recommend: 14-day no-questions)
- [ ] License audit: script greps client bundle for GPL deps = zero
- [ ] Stripe live mode, webhook endpoint verified, tax settings (Stripe Tax) configured for your country
- [ ] Backup restore drill performed and documented
- [ ] Rate limits verified with k6; engine queue survives worker kill
- [ ] Password reset + email verify tested on real inboxes (not spam-foldered)
- [ ] Uptime monitor + Sentry alerts to your phone
- [ ] Seed content: 20 annotated famous games public for SEO/demo
- [ ] Cancel-flow tested: sub canceled in portal → plan downgrades at period end, data retained

---

## 18. Decisions log (amend deliberately)
1. Engine server-side only — licensing safety (§3).
2. Web-first SaaS, no desktop bundle at launch — distribution + GPL simplicity.
3. Python/FastAPI backend — python-chess maturity for the data pipeline.
4. One Postgres for everything until >50M games — operational simplicity.
5. Zobrist-row position index over bitboard search — simpler, good enough at 3–5M games.
6. Single Pro tier — pricing simplicity; revisit after 500 subscribers.

*End of blueprint — v1.0. Keep this file updated as the project's constitution.*
