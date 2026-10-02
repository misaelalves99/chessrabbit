# ChessRabbit Community

Free, open-source chess analysis, game storage, opening study and training. Run it on your own computer with Stockfish, Leela Chess Zero (Lc0), or another UCI engine.

## Run on your computer

Install Docker Desktop (Windows/macOS) or Docker Engine with the Compose plugin (Linux). Download this branch as a ZIP and extract it, or clone it:

```sh
git clone --branch codex/open-source-local-engines https://github.com/shivamjg101/chessrabbit.git
cd chessrabbit
docker compose up --build -d
```

Open **http://localhost:3000/app**. No account registration, payment credentials or email provider is needed in local mode. The first build needs internet access; your own PGN files and installed engines then work offline.

Stockfish is included. **Leela is optional and requires a network file.** See [Local setup](docs/LOCAL_SETUP.md) for CPU Docker setup, native Windows/GPU engines, custom profiles, backups and troubleshooting.

To stop the app and keep your data: `docker compose down`.

## Features

- Live position analysis with selectable depth and candidate lines.
- Full-game reviews, move annotations, accuracy and mistake training.
- PGN import/export, collections, opening explorer and reference search.
- Studies with variations, comments and board annotations.
- Opening repertoires, spaced repetition, puzzles and opponent preparation.
- Optional Lichess/Chess.com imports and public player insights.

Every feature is available to every account. Resource limits apply equally to protect the machine running the app. There are no paid plans, billing routes, subscription checks or license keys.

Your games and results are stored in local Docker volumes. A new install starts with an empty personal/reference database. Reference games, puzzles, neural networks and Syzygy tablebases are optional datasets installed separately.

## Project layout

| Directory | Purpose |
| --- | --- |
| `apps/web` | Next.js/React/TypeScript interface, exported as static files |
| `apps/api` | FastAPI, authentication, chess data and analysis API |
| `services/engine` | Python UCI worker, engine profiles, Redis queues |
| `db/migrations` | PostgreSQL schema |
| `pipeline` | Reference-game and puzzle import tools |
| `engines` | Examples and ignored local engine/network files |

The browser calls the local API; the API queues jobs for a selected engine. Workers run engine binaries as separate processes and store results in PostgreSQL. Cache identities include the engine profile, reported version, options and network contents.

## Development and upgrades

See [Development](docs/DEVELOPMENT_GUIDE.md), [Architecture](BLUEPRINT.md) and [Contributing](CONTRIBUTING.md).

Existing installations must apply `db/migrations/016_community_edition.sql` before running this branch. Back up first. Older subscription records are retained as inert historical tables; no runtime code reads or writes them. Schema changes only run automatically on a fresh database volume.

## License

ChessRabbit is licensed under **GPL-3.0**, see [LICENSE](LICENSE). Third-party software and datasets retain their licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This branch provides source and Docker build recipes; native installers and prebuilt release packages are future work.
