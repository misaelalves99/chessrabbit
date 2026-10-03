# Legal and Compliance Notes

This file summarizes the legal material that should travel with public downloads. It is not legal advice.

## License

ChessRabbit is licensed under GPL-3.0. The complete license text is in `LICENSE` and the source repository should remain available to everyone who receives an installer or binary build.

## Source code for binary releases

When distributing `ChessRabbit-Setup.exe`, publish the corresponding ChessRabbit source for that exact release, including build scripts and license notices. The current release process attaches `ChessRabbit-Source.zip` beside the installer.

## Stockfish and GPL components

The Windows installer includes Stockfish. Stockfish is GPL-3.0, so releases must preserve its copyright notices, license text and corresponding source. The release process publishes the upstream Stockfish source archive beside the installer and keeps Stockfish notices in the installed resources.

Python-chess and optional Leela Chess Zero integrations are GPL-family components. Keep ChessRabbit under a GPL-compatible license and preserve notices when redistributing these components.

## Third-party notices

`THIRD_PARTY_NOTICES.md` lists the major third-party projects used by ChessRabbit and where their license information can be found. Dependency lockfiles and packaged license folders may contain additional direct and transitive notices.

## Data and external services

ChessRabbit does not grant rights to redistribute third-party chess databases, puzzle datasets, neural-network files, tablebases or imported games. Only include data that you have the right to distribute, and follow the terms of Lichess, Chess.com and any other external service used for imports.

## Warranty

ChessRabbit is provided without warranty to the extent permitted by law. Engine evaluations, accuracy scores, opening suggestions and training statistics are estimates and should not be treated as professional, financial or legal advice.

## Donations

Donations are optional support for development. They do not unlock paid features, subscriptions, warranties or private licenses.
