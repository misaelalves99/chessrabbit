# Deploying ChessRabbit

## The web tier is a static bundle

`apps/web/next.config.js` sets `output: "export"`. Every route in the app is
client-rendered and talks to the API over HTTP, so `next build` emits a plain
static site into `apps/web/out` — 1.6 MB, 18 prerendered routes, no Node
process. A CDN serves it for free.

```bash
cd apps/web
NEXT_PUBLIC_API_URL=https://api.chessrabbit.app \
NEXT_PUBLIC_WS_URL=wss://api.chessrabbit.app \
npm run build
# upload apps/web/out/ to Cloudflare Pages / Netlify / S3+CloudFront
```

### Two things that will bite you

**`NEXT_PUBLIC_*` are inlined at build time, not read at runtime.** The API
host is baked into the JavaScript. Pointing the frontend at a different API
means rebuilding and re-uploading — you cannot change it with an env var on a
running container, because there is no running container.

**The CDN origin must be allowed by CORS.** `apps/api/app/main.py` builds
`allow_origins` from `APP_BASE_URL`. If the bundle is served from
`https://chessrabbit.app` but `APP_BASE_URL` still says something else, every
API call fails in the browser with an opaque CORS error while `curl` against
the API keeps working. Set `APP_BASE_URL` to the exact origin serving the
bundle, scheme included.

## Self-hosting without a CDN

`docker-compose.prod.yml` builds the bundle and serves it with
`apps/web/serve-static.mjs`, a dependency-free static server:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Override the build-time URLs with `APP_API_URL` / `APP_WS_URL`. Put Caddy or a
CDN in front for HTTPS and compression — `serve-static.mjs` does neither, and
is not meant to face the internet directly.

Once a CDN serves the bundle, the `web` service can be deleted from the
compose file entirely.

## Why this is worth doing

It removes a Node process (and its memory) from the box at launch, and the
static bundle costs nothing to serve on any CDN free tier. This is
`SCALABILITY_PLAN.md` Phase 2 step 4, pulled forward — there is no reason to
wait for the Phase 2 trigger, since it is free at any scale.
