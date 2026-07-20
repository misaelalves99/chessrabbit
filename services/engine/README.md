# Engine Service

Runs Stockfish server-side and consumes analysis jobs from Redis.

## Licensing (important)

Stockfish is GPL-3.0. This service runs an **unmodified official binary** as a
separate process communicating over UCI text pipes. The binary exists **only on
the server** and is never distributed to end users, so GPL obligations are not
triggered for your application code.

**Never** compile Stockfish to WASM for the browser or bundle it in a desktop
build without re-reading BLUEPRINT.md Section 3.

## Flow

1. API pushes a job onto `q:pro` or `q:free` (Redis list)
2. Worker pops the job, checks `analysis_cache` for the position's zobrist hash
3. Cache hit -> publish result instantly, zero CPU
4. Cache miss -> run Stockfish, stream `info` lines to `eval:{job_id}` pub/sub
5. On `bestmove` -> persist to `analysis_cache`, mark job done

## Local run without Docker

```bash
sudo apt install stockfish        # or: brew install stockfish
pip install -r requirements.txt
REDIS_URL=redis://localhost:6379/0 \
DATABASE_URL=postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit \
python worker.py
```
