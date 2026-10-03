# Deployment

The default [Compose file](../docker-compose.yml) is a personal localhost installation. Follow [Local setup](LOCAL_SETUP.md).

The community edition can also be self-hosted for several users. Disable LOCAL_MODE and configure the API using [.env.example](../.env.example), a strong persistent secret, TLS and your email backend. Set frontend API/WebSocket URLs at build time. Serve the exported `apps/web/out` directory as static files. Do not expose PostgreSQL or Redis to the internet.

The old production Compose override was removed because it assumed a development Node container and is incompatible with the new static local image. A public hosting configuration must be designed for its actual host and reverse proxy.

No payment service is required. See [Security](SECURITY.md) and [Architecture](../BLUEPRINT.md).
