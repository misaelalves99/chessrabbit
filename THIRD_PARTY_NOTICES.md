# Third-party notices

ChessRabbit source is GPL-3.0. Dependency licenses continue to apply independently.

| Component | License | Source |
| --- | --- | --- |
| Stockfish | GPL-3.0 | https://github.com/official-stockfish/Stockfish |
| Leela Chess Zero (optional) | GPL-3.0-or-later | https://github.com/LeelaChessZero/lc0 |
| python-chess | GPL-3.0-or-later | https://github.com/niklasf/python-chess |
| chess.js | BSD-2-Clause | https://github.com/jhlywa/chess.js |
| react-chessboard | MIT | https://github.com/Clariity/react-chessboard |
| Next.js | MIT | https://github.com/vercel/next.js |
| React | MIT | https://github.com/facebook/react |
| FastAPI | MIT | https://github.com/fastapi/fastapi |
| SQLAlchemy | MIT | https://github.com/sqlalchemy/sqlalchemy |
| PostgreSQL | PostgreSQL License | https://www.postgresql.org/about/licence/ |
| Redis 7.2 | BSD-3-Clause | https://github.com/redis/redis/tree/7.2 |

See Python requirement files, the npm lockfile and installed packages for all direct/transitive dependencies and their license texts. Container base images include additional operating-system packages and notices.

The default worker installs Debian's Stockfish package. Its package copyright/source information is available in the image and through https://packages.debian.org/bookworm/stockfish . The optional Lc0 Dockerfile builds upstream tag v0.32.1 from its source and submodules.

When redistributing images or engine binaries, preserve copyright/license notices and provide corresponding source and build material as required by their licenses. Links here are attribution; they are not a replacement for providing corresponding source for the exact binaries you distribute. These recipes do not produce a bundled native installer.

Neural-network files, Syzygy tablebases, reference games and puzzle datasets are obtained separately. Check their licenses before redistribution. Lichess database releases document their data terms at https://database.lichess.org . Public availability of games does not by itself grant unrestricted redistribution rights.
