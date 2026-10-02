# Contributing

Open an issue or pull request with a reproducible problem or concrete improvement. Keep the local setup usable without paid services and make all features available to all accounts.

Use GPL-3.0-compatible contributions and preserve third-party notices. Do not commit credentials, game dumps, engine binaries or network weights.

Run the checks in [Development](docs/DEVELOPMENT_GUIDE.md). Changes to engine integration should include UCI protocol tests and a smoke test using an actual engine when available. Describe any untested platform or hardware requirements.

Schema changes are numbered SQL migrations. Preserve user games, annotations and training progress during upgrades.
