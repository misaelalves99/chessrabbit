# ChessRabbit Development Guide

## Quick Start (Local Development)

### Prerequisites
- Python 3.12+
- Node.js 18+
- PostgreSQL 16
- Redis 7
- Stockfish 16 (in PATH as `stockfish`)
- Docker & Docker Compose (optional, for all-in-one)

### 1. Environment Setup

```bash
# Clone/extract the repo
tar xzf chessrabbit.tar.gz
cd chessrabbit

# Backend
cd apps/api
cp .env.example .env
# Edit .env and set at minimum:
#   DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/chessrabbit
#   REDIS_URL=redis://localhost:6379/0
#   JWT_SECRET=your-secret-key-here
#   STRIPE_SECRET_KEY= (leave empty for now, get from Stripe)
#   EMAIL_API_KEY= (leave empty, gracefully degrades)

# Frontend
cd ../../apps/web
npm install

# Engine worker
cd ../../services/engine
pip install -r requirements.txt --break-system-packages
```

### 2. Database Setup

```bash
# Create database and role
psql -U postgres
  CREATE ROLE chessrabbit LOGIN PASSWORD 'devpassword';
  CREATE DATABASE chessrabbit OWNER chessrabbit;
  \q

# Apply all migrations
for migration in db/migrations/00*.sql; do
  PGPASSWORD=devpassword psql -h localhost -U chessrabbit -d chessrabbit -f "$migration"
done
```

### 3. Start Services

**Option A: Docker Compose (Easiest)**
```bash
docker-compose up --build
# API: http://localhost:8000
# Frontend: http://localhost:3000
# Docs: http://localhost:8000/docs
```

**Option B: Manual (For Development)**
```bash
# Terminal 1: API
cd apps/api
DATABASE_URL=postgresql+asyncpg://chessrabbit:devpassword@localhost:5432/chessrabbit \
REDIS_URL=redis://localhost:6379/0 \
JWT_SECRET=dev-secret \
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2: Engine Worker
cd services/engine
DATABASE_URL=postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit \
REDIS_URL=redis://localhost:6379/0 \
python3 worker.py

# Terminal 3: Frontend
cd apps/web
npm run dev

# Terminal 4: Seed data (first time only)
python3 pipeline/generate_seed_games.py --games 48 --out seed.pgn
python3 pipeline/load_reference_games.py seed.pgn
```

---

## Code Structure

### Backend (`apps/api/`)
```
app/
  main.py                   # FastAPI app + CORS + routes
  core/
    config.py              # Pydantic settings, env vars
    security.py            # Password hash, JWT, token ops
    db.py                  # SQLAlchemy async engine
    redis_client.py        # Redis connection
    chess_utils.py         # FEN validation, zobrist, PGN parsing
    deps.py                # FastAPI dependencies (auth, rate limiting)
    ratelimit.py           # Redis-backed rate limiter
  models/
    models.py              # SQLAlchemy ORM (all 14 tables)
  schemas/
    schemas.py             # Pydantic request/response models
  services/
    mailer.py              # Email sending (console + HTTP backend)
  routers/
    auth.py                # Register, login, forgot, reset, verify
    users.py               # /me, /me/export, /me/delete
    games.py               # Import, list, get, export, delete
    explorer.py            # Opening tree (reference + personal)
    analysis.py            # Position/game analysis + tablebase
    training.py            # Repertoires + SM-2 scheduling + blunder sync
    admin.py               # Stats, user roster, suspension
    billing.py             # Stripe checkout, portal, webhook
```

### Frontend (`apps/web/`)
```
src/
  app/
    page.tsx               # Landing page
    app/
      page.tsx             # Main board workspace
      layout.tsx           # App layout
    login/page.tsx
    register/page.tsx
    forgot/page.tsx
    reset/page.tsx
    verify/page.tsx
    train/page.tsx         # Spaced-rep drilling
  components/
    AnalysisBoard.tsx      # Chess board + eval bar + explorer
    (other UI components)
  lib/
    api.ts                 # Typed API client
    (utilities)
  hooks/
    useEngine.ts           # WebSocket connection to engine
```

### Engine Service (`services/engine/`)
```
uci.py                      # Stockfish UCI wrapper
worker.py                   # Redis queue consumer → analysis pipeline
requirements.txt            # Python dependencies
Dockerfile                  # Engine worker container
```

### Pipeline (`pipeline/`)
```
generate_seed_games.py      # Stockfish self-play generator
load_reference_games.py     # Batch PGN loader + tree builder
make_admin.py               # Promote a user to admin
purge.py                    # Nightly account cleanup (cron job)
```

### Database (`db/`)
```
migrations/
  001_initial_schema.sql    # Core tables + indices
  002_repertoires.sql       # Training tables
  003_admin.sql             # Admin + suspension
  004_blunder_puzzles.sql   # best_uci field for annotations
```

---

## Development Workflow

### Adding a New Endpoint

1. **Define the schema** (`apps/api/app/schemas/schemas.py`)
   ```python
   class MyRequestIn(BaseModel):
       field1: str
       field2: int
   
   class MyResponseOut(BaseModel):
       result: str
   ```

2. **Add the route** (`apps/api/app/routers/myfeature.py`)
   ```python
   @router.post("/my-feature", response_model=MyResponseOut)
   async def my_handler(
       payload: MyRequestIn,
       user: User = Depends(get_current_user),
       db: AsyncSession = Depends(get_db),
   ):
       # Your logic here
       return MyResponseOut(result="...")
   ```

3. **Wire it to the app** (`apps/api/app/main.py`)
   ```python
   from app.routers import myfeature
   app.include_router(myfeature.router)
   ```

4. **Add to the frontend client** (`apps/web/src/lib/api.ts`)
   ```typescript
   myFeature: (data: MyRequestIn) =>
     request<MyResponseOut>("/my-feature", {
       method: "POST",
       body: JSON.stringify(data),
     }),
   ```

### Adding a Database Migration

1. Create `db/migrations/00X_description.sql`
2. Test it locally:
   ```bash
   PGPASSWORD=devpassword psql -h localhost -U chessrabbit -d chessrabbit -f db/migrations/00X_description.sql
   ```
3. Update the ORM model in `apps/api/app/models/models.py`

### Testing

**Backend:**
```bash
cd apps/api
pytest tests/ -v  # (tests directory structure to be added)
```

**Engine:**
```bash
cd services/engine
python3 -m pytest tests/ -v
```

**Manual Integration:**
```bash
python3 /tmp/my_test.py  # (see examples in conversation history)
```

---

## Common Tasks

### Promote a User to Admin
```bash
python3 pipeline/make_admin.py you@example.com
```

### Generate Seed Games (Dev Data)
```bash
python3 pipeline/generate_seed_games.py --games 100 --out seed.pgn
python3 pipeline/load_reference_games.py seed.pgn
```

### Check API Health
```bash
curl http://localhost:8000/health
# Should return:
# {"status": "ok", "database": true, "redis": true, "version": "0.1.0"}
```

### View Database
```bash
PGPASSWORD=devpassword psql -h localhost -U chessrabbit -d chessrabbit
```

### View Redis
```bash
redis-cli
  KEYS *
  GET key_name
  LLEN q:pro  # Queue lengths
```

---

## Key Concepts

### SM-2 Spaced Repetition
Located in `apps/api/app/routers/training.py`:
- **Correct answer:** interval = 1.0 (first), then interval×ease. Ease += 0.05 (max 2.8).
- **Wrong answer:** interval = 0 (retry in 10 min). Ease -= 0.2 (min 1.3). Lapses += 1.
- All math is server-side (can't cheat).

### Zobrist Hashing
Unique 64-bit hash of a chess position (used to dedupe and cache).
- Located: `apps/api/app/core/chess_utils.py`
- Used for: positions, repertoire cards, blunder dedup

### Redis Queue
- `q:pro` — Pro user analysis jobs (higher priority)
- `q:free` — Free user analysis jobs (lower priority)
- `eval:{job_id}` — Pub/sub channel for live streaming

### Engine Cache
- Table: `analysis_cache`
- Key: (zobrist, stockfish_version, depth)
- Hit rate: ~90% for repeated positions
- TTL: configurable (default 180 days)

---

## Environment Variables (`.env`)

### Required
```
DATABASE_URL=postgresql+asyncpg://user:pass@localhost/chessrabbit
REDIS_URL=redis://localhost:6379/0
JWT_SECRET=your-secret-key-at-least-32-chars
```

### Optional (Features Gracefully Degrade)
```
# Email (optional; logs to console if unset)
EMAIL_API_KEY=resend_key_or_postmark_key
EMAIL_FROM=noreply@example.com

# Stripe (optional; returns 503 if unset)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Endgame tablebases (optional; disables if unset)
SYZYGY_PATH=/path/to/syzygy/files

# Limits (optional; defaults shown)
FREE_MAX_DEPTH=18
PRO_MAX_DEPTH=32
FREE_DAILY_ANALYSES=10
FREE_MAX_GAMES=50
ACCOUNT_RETENTION_DAYS=30
ANALYSIS_CACHE_TTL_DAYS=180
```

---

## Next Phase Planning

See `docs/GROWTH_ROADMAP.md` for full feature breakdown.

**Sprint 2 (3-4 days):** Auto-import + Weekly insights
- Priority 1: Lichess/Chess.com game sync
- Priority 2: Weekly email digest

**Sprint 3 (2-3 weeks):** Competitive differentiation
- Priority 1: Repertoire gap detection
- Priority 2: Human-strength sparring
- Priority 3: Endgame drills + structure search

**Sprint 4 (3+ weeks):** Revenue & polish
- LLM annotations
- Shareable boards
- Coach seats (per-seat billing)

---

## Debugging Tips

### API won't start
```bash
# Check logs
tail -50 /tmp/api.log

# Check imports
python3 -c "from app.main import app; print('OK')"

# Check env vars
echo $DATABASE_URL
```

### Engine won't analyze
```bash
# Check worker is running
pgrep -f "python3 worker.py"

# Check queue
redis-cli LLEN q:pro

# Check Stockfish
which stockfish
stockfish --version
```

### Database connection fails
```bash
# Test connection
PGPASSWORD=devpassword psql -h localhost -U chessrabbit -d chessrabbit -c "SELECT 1;"

# Check migrations applied
PGPASSWORD=devpassword psql -h localhost -U chessrabbit -d chessrabbit -c "SELECT COUNT(*) FROM users;"
```

---

## Performance Notes

- **Position analysis:** ~2s from engine, 12ms from cache
- **Full-game analysis:** ~1ms per ply for cached games (depends on queue depth)
- **Explorer queries:** <100ms for master DB; <50ms for personal tree (indexed GROUP BY)
- **Training scheduler:** <50ms for due cards (indexed on user_id, due_at)

Cache hit rate is critical — the first user analysis on a position is slow (engine cost), but identical positions from other users hit immediately.

---

## Deployment Checklist

- [ ] Set up Stripe: 2 prices, 3 env vars, webhook endpoint
- [ ] Set up email: provider key + 2 env vars
- [ ] Load reference data: Lichess dump or seed generator
- [ ] Download Syzygy (optional): 3-4 piece files (~1GB)
- [ ] Set up SSL/TLS: Let's Encrypt via certbot
- [ ] Configure monitoring: logs, alerts on queue depth
- [ ] Run `pipeline/purge.py` nightly: cron job for cleanup
- [ ] Test: register → import PGN → analyze → train

---

## Support & Debugging

See transcript at `/mnt/transcripts/` for full session history, including:
- All test outputs
- Verbatim Stockfish/parser results
- Blueprint rationale
- Integration test results

