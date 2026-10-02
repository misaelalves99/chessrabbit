# Resource tuning

Community deployments use the same resource bounds for every account.

ENGINE_WORKERS controls processes per profile. ENGINE_THREADS_PER_JOB and ENGINE_HASH_MB control per-process resources. Profiles can override their worker count. With more than one worker, the last consumer only handles interactive requests so a long review cannot occupy every process.

Each configured profile creates its own pool. Two profiles with three workers and 256 MB hash each can consume substantial RAM. Start with the default one worker and 64 MB hash; increase after measuring your machine.

ENGINE_MAX_MOVETIME_MS bounds analysis time per position. API limits cover depth, candidate lines, concurrent live boards and batch request size. Caches are partitioned by profile, version, options and neural-network contents.

BLPOP queues currently lack acknowledgments/retries. Multi-host workers also require shared engine configuration and a different catalog scheme. See [Architecture](../BLUEPRINT.md) before scaling beyond a single worker deployment.
