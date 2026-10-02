# UCI worker

Runs locally configured Stockfish, Leela Chess Zero or other UCI subprocesses.

Start with the root Docker Compose stack. Optional CPU Lc0 and native Windows/GPU instructions are in [Local setup](../../docs/LOCAL_SETUP.md).

ENGINES_CONFIG points to a trusted JSON array of profiles. Each includes id, name, binary, optional args/options/workers. Without it the registry offers Stockfish and optional Lc0 from STOCKFISH_PATH, LC0_PATH and LC0_WEIGHTS_PATH.

The worker advertises available engines through a Redis catalog refreshed every 30 seconds. Requests use per-engine interactive/batch queues. Cache keys include profile settings, UCI version and network contents; cache hits must have the requested depth and candidate-line count.

Only one worker deployment should publish to a given Redis catalog. Profiles are loaded at startup; restart after changing binaries, options or networks. Tests: `python -m pytest services/engine/tests -q`.
