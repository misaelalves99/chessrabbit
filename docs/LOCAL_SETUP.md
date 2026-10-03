Download [ChessRabbit-Setup.exe](https://github.com/shivamjg101/chessrabbit/releases/download/desktop-v0.1.1/ChessRabbit-Setup.exe), run it, and open ChessRabbit from the desktop or Start menu. The installer includes Stockfish and local storage. Desktop users do not need the development setup below.

# Local setup

This guide is for developers and self-hosters who want to run ChessRabbit from source.

## Docker setup

Install Docker Desktop on Windows or macOS, or Docker Engine with the Compose plugin on Linux.

```sh
docker compose up --build -d
```

Open http://localhost:3000/app .

The web interface, API, database and Redis are bound to 127.0.0.1. Local mode creates a personal account when the app opens. It accepts bootstrap requests only from the configured web origin. An ephemeral signing secret is generated when no secret is supplied; sessions renew automatically after restarting the API. Use a single API process in this mode.

## Engine profiles

Stockfish is included. To add a native engine, create an engine profile in `engines/engines.example.json` and point it at your executable. Each profile has a unique lowercase `id`, display `name`, `binary`, optional `args`, `options` and `workers`. In Docker, use Linux binaries for the container's architecture and include their required libraries. Windows `.exe` files cannot run in Linux containers. Profiles are trusted local configuration; the API never accepts executable paths from browser requests.

Lc0 requires both an engine and a compatible neural network. Obtain a network from the [official Lc0 downloads](https://lczero.org/play/download/) and check its license. Save it as `engines/lc0/network.pb.gz` (create the directory first).

## Native Windows/GPU worker

Run the web/API/database stack in Docker, then run an engine worker directly on Windows to use Windows engine binaries and GPU drivers.

1. Start Docker normally.
2. Install Python 3.12 on Windows.
3. Download an appropriate [Stockfish build](https://stockfishchess.org/download/) and [Lc0 package](https://lczero.org/play/download/) with its network and required runtime libraries.
4. Create an engine config JSON outside the repository or under ignored `engines/` paths.
5. Run the worker with environment variables pointing at the Docker Redis and API database.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services/engine/requirements.txt
$env:REDIS_URL = "redis://localhost:6379/0"
$env:DATABASE_URL = "postgresql://chessrabbit:chessrabbit@localhost:5432/chessrabbit"
$env:ENGINES_CONFIG = "$PWD\engines\engines.example.json"
.\.venv\Scripts\python.exe services\engine\worker.py
```

Keep that worker running. Run only one worker deployment against this Redis catalog at a time. The same approach works on macOS/Linux with native binaries and shell environment variables.

## Optional data

The default stack has no downloaded games, puzzles, tablebases or networks. Import your own PGN on the board immediately. Opening repertoire drills work from the bundled catalog. Populate optional reference and puzzle data using `pipeline` scripts; their CLI help documents input formats.

## Backups

```powershell
docker compose exec -T postgres pg_dump -U chessrabbit -Fc -f /tmp/chessrabbit.backup chessrabbit
docker cp chessrabbit-postgres-1:/tmp/chessrabbit.backup .\chessrabbit.backup
```

To restore, stop the stack, recreate the database volume, start PostgreSQL and use `pg_restore` into the empty database.

## Migration from older paid-plan builds

```powershell
docker compose exec -T postgres psql -U chessrabbit -d chessrabbit -v ON_ERROR_STOP=1 -f /tmp/016.sql
```

Migration `016_community_edition.sql` removes runtime plan enforcement assumptions while preserving old account records. Back up first.

## Shared hosting warning

Local mode is for personal localhost use. A shared/public installation must disable LOCAL_MODE, use a persistent strong JWT secret, HTTPS, configured email, protected backend services and appropriate backups. See [Security](SECURITY.md).
