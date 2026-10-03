# Contributing

Open an issue or pull request with a reproducible problem or concrete improvement. Keep the local setup usable without paid services and make all features available to all accounts.

## Your first contribution

1. Browse [good first issues](https://github.com/shivamjg101/chessrabbit/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) or [help wanted](https://github.com/shivamjg101/chessrabbit/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22). Check for an existing pull request and leave a comment if you plan to work on an issue so contributors can coordinate.
2. Fork the repository, branch from `main`, and follow [Local setup](docs/LOCAL_SETUP.md) and [Development](docs/DEVELOPMENT_GUIDE.md). You can work on web/API changes without building the Windows installer.
3. Keep your change focused on one problem. For a larger idea, discuss the approach in an issue or [Discussions](https://github.com/shivamjg101/chessrabbit/discussions) first.
4. Run the relevant checks below. Explain what you tested and any environment limitations; include before/after screenshots for visible UI changes without exposing tokens or private games.
5. Open a pull request against `main` and link the issue with `Fixes #NUMBER`. Draft pull requests are welcome for work in progress.

Useful non-code contributions include reproducing a bug, testing the installer, documenting a verified Leela setup and improving accessibility. Please avoid mass formatting changes, duplicate issues and pull requests whose only purpose is contribution counting. If you use AI assistance, review and understand the result, verify its behavior, and be transparent about what you did and did not test.

For October newcomers, see [Hacktoberfest 2026](docs/HACKTOBERFEST.md). ChessRabbit does not promise event credit, prizes or a response deadline.

## Licensing and validation

Use GPL-3.0-compatible contributions and preserve third-party notices. By contributing, you certify that you have the right to submit the work and agree that your contribution is licensed under GPL-3.0 as part of ChessRabbit. Do not commit credentials, game dumps, engine binaries, neural-network weights or tablebases unless the project explicitly documents that they may be redistributed.

Run the checks in [Development](docs/DEVELOPMENT_GUIDE.md). Changes to engine integration should include UCI protocol tests and a smoke test using an actual engine when available. Describe any untested platform or hardware requirements.

Schema changes are numbered SQL migrations. Preserve user games, annotations and training progress during upgrades.
