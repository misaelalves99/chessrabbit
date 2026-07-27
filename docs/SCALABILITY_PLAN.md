# ChessRabbit Scalability Plan

**Written:** July 20, 2026
**Scope:** How to take the current single-box Docker Compose deployment to thousands of
concurrent users without rewrites. Phases are keyed to load thresholds, not dates —
do not execute a phase before its trigger fires.

Guiding principle (BLUEPRINT §14): the queue architecture already decouples every
expensive component. Scaling is mostly *adding copies*, not changing code. The few
places where code changes ARE needed are all in Phase 0, so do them first.

---

## Where the load actually goes

| Component | Cost driver | Scales by | Current limit |
|---|---|---|---|
| Stockfish workers | CPU-seconds per analysis | adding worker containers/nodes | **serial job loop (see 0.1)** |
| Postgres | `game_positions` size + search queries | tuning → dedicated node → partitioning | ~100 connections, single node |
| Redis | queue + pub/sub + rate limits | basically never (tiny payloads) | single instance (fine to ~10k users) |
| FastAPI | WS connections + JSON serialization | more uvicorn workers / replicas | runs single-process dev mode |
| Next.js web | static assets + SSR | CDN + replicas | runs `npm run dev` |
| Analysis cache | — (it *reduces* load) | hit-rate grows with traffic | none — it's the flywheel |

The one metric that matters most: **cache hit rate on `analysis_cache`**. Every hit is an
analysis that cost $0. Popular positions converge to ~100% hit rate, so marginal engine
cost per user *falls* as the user base grows. Protect the cache (never bypass it, never
let the purge TTL get aggressive) and the engine fleet stays small.

---

## Phase 0 — Code fixes that unlock scaling ✅ SHIPPED July 20, 2026

These are the only *code* changes in the whole plan. Everything after is operations.
All five items below are implemented and verified on the live stack: a full-game
batch job plus three position analyses ran concurrently across the 3-engine pool
(consumers picked up within 100 ms of each other; batch landed on a non-reserved
consumer). Also fixed en route: Debian installs Stockfish at /usr/games, which
python:3.12-slim omits from PATH — binary resolution now covers that.

### 0.1 Parallelize the engine worker loop  ← biggest single win
`services/engine/worker.py` boots `EnginePool(size=POOL_SIZE)` (default 3 engines) but
`main()` pops and processes **one job at a time**. Two of three engines are always idle,
and one full-game job (minutes) blocks every live position analysis on the node.

Fix: spawn `POOL_SIZE` consumer tasks over the same queue loop; `pool.acquire()` already
serializes access to engines. Result: 3× throughput on the same hardware, zero new infra.

### 0.2 Separate queue for batch jobs
Full-game annotation holds an engine for minutes. Add `q:batch` (drained after `q:pro`,
`q:free`) and route `full_game` jobs there; reserve at most `POOL_SIZE - 1` concurrent
batch jobs so one engine is always free for live analysis. Prevents the "I toggled the
engine and nothing happened for 4 minutes" support ticket.

### 0.3 Production process managers
- API: `uvicorn --workers 4` (or gunicorn+uvicorn workers) via a compose prod profile —
  currently the compose command is dev-mode `--reload`, single process.
- Web: `next build && next start` (or static export behind Caddy) — currently `npm run dev`.

### 0.4 Job-table hygiene
`analysis_jobs` grows without bound (the nightly purge doesn't touch it). Add to
`pipeline/purge.py`: delete `done|failed|canceled` jobs older than 30 days.

### 0.5 Connection-math guardrails
Each API process opens up to 30 Postgres connections (`pool_size=10, max_overflow=20` in
`app/core/db.py`). 4 uvicorn workers = up to 120 > Postgres default `max_connections=100`.
Set `pool_size=5, max_overflow=5` per worker now; adopt pgbouncer in Phase 2.

---

## Phase 1 — One good VPS (launch → ~500 active users)

**Trigger:** launching.
**Hardware:** Hetzner CCX33 (8 dedicated vCPU / 32 GB) per BLUEPRINT §14. ~€50/mo.

- Everything on one box via compose: Caddy (HTTPS) → web + api; postgres; redis; 1 engine
  container with `ENGINE_WORKERS=3`, `Threads=2` → ~3 concurrent deep analyses after 0.1.
- Postgres tuning: `shared_buffers=8GB`, `effective_cache_size=24GB`, `max_wal_size=4GB`.
- Redis: `maxmemory 2gb`, `maxmemory-policy allkeys-lru` is **wrong** here — queues must
  never be evicted. Use `noeviction` and alert at 75% memory.
- Observability floor: queue depth + oldest-job age exposed in `/admin/stats` (queue depth
  already there), Uptime Kuma ping on `/health`, Sentry on api + web.
- Nightly: `pg_dump` to object storage, purge job, `sync_all` (auto-import).

**Capacity estimate:** ~50 analyses/hour/engine at depth 22 avg → ~150/hour/node raw;
with a warm cache (≥50% hit rate after the first weeks) ≈ 300+ user-visible analyses/hour.
That serves hundreds of daily actives comfortably.

**Exit signal:** `q:free` oldest-job age > 60 s sustained during peak, or API p95 > 300 ms.

---

## Phase 2 — Split the fleet (500 → 5,000 active users)

**Trigger:** the exit signals above; typically ~1–2k DAU or ~200 Pro subscribers.

1. **Engine-only nodes** (the designed scale path, zero code change): cheap dedicated-CPU
   boxes running only the engine container, pointed at the main box's Redis over a private
   network (Hetzner vSwitch). Add nodes until queue age is healthy. Each CPX41-class node
   ≈ €30/mo adds ~3–6 concurrent analyses.
2. **Postgres to its own node** (or managed PG): the position index and search queries
   stop competing with engine CPU. Add pgbouncer (transaction pooling) in front.
3. **API replicas:** 2–3 uvicorn containers behind Caddy. JWT auth is stateless and WS
   fan-out already goes through Redis pub/sub, so this is pure config. Sticky sessions
   are NOT needed (each WS connection is independent).
4. **Web:** `next build` output behind a CDN (Cloudflare free tier). The board workspace
   is a static bundle; only API calls are dynamic.
5. **Backpressure:** cap `q:free` length (reject with "try again shortly" past ~500
   queued); pro queue stays uncapped — that asymmetry is the upgrade pitch working.

**Cost at this phase:** ~€150–250/mo total. Gross margin stays >80% at 200+ Pro subs.

**Exit signal:** `game_positions` > ~300M rows (≈ 8M reference games), or search p95
degrading despite index-only scans, or single Redis CPU > 60%.

---

## Phase 3 — Data-layer surgery (5,000+ users, 50M+ games)

**Trigger:** data signals above. Most products never get here; do not pre-build.

- **Partition `game_positions`** by zobrist hash range (`PARTITION BY HASH (zobrist)`,
  16–32 partitions). Position search hits exactly one partition; vacuum and index bloat
  become manageable. This is the blueprint's designated growth valve (§7.4).
- **Read replica** for reference-DB search + explorer + position search (all read-only
  by construction); primary keeps writes (users, games, cache, jobs).
- **Opening tree stays precomputed** — it's already O(1) reads; rebuild monthly on the
  replica and swap. If explorer QPS alone gets hot, add a Redis cache keyed by zobrist
  (TTL 1 day) in front of it.
- **Redis:** split rate-limit/pub-sub onto a second instance if needed; move queues to
  Redis Streams only if at-least-once delivery becomes a requirement (job retry on
  worker death — today a killed worker loses its in-flight job; acceptable while jobs
  are cheap to resubmit).
- **Analysis cache:** it is append-mostly and small relative to positions (one row per
  *analyzed* position, not per game position). Keep it on the primary forever.

**Explicitly rejected at every phase** (revisit only with evidence): Kubernetes,
microservices, ClickHouse before partitioning is exhausted, multi-region, GraphQL,
serverless engines (cold-start kills UCI), and any change that ships Stockfish to the
client (BLUEPRINT §3 — licensing, non-negotiable).

---

## Load-test gates (run before each phase transition)

k6 scripts (BLUEPRINT §13):
1. 50 concurrent live WS analyses — queue degrades by *waiting*, never crashing.
2. Kill an engine container mid-job — supervisor respawns, job fails cleanly, next job runs.
3. Search + explorer at 100 RPS with a cold cache — p95 < 500 ms.
4. Import a 10 MB PGN while the above runs — no starvation of interactive traffic.

## Monitoring thresholds (alert, don't stare at dashboards)

| Signal | Warn | Act |
|---|---|---|
| `q:free` oldest job age | > 30 s | > 60 s sustained → add engine node |
| Cache hit rate (7-day) | < 40% | investigate cache TTL / bypass bugs |
| Postgres connections | > 70% of max | pgbouncer / lower pool size |
| Redis memory | > 60% | > 75% → grow instance (queues must never evict) |
| API p95 latency | > 200 ms | > 300 ms → add API replica |
| Disk (pgdata) | > 60% | plan partition/archive before 80% |
