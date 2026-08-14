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

## Security headers

`serve-static.mjs` sets CSP, `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options` and `Permissions-Policy` on every response, and the API sets
its own (stricter) set in `apps/api/app/main.py`.

The CSP's `connect-src` is built from `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`
**at container start**, so a deployment pointed at a different API automatically
gets a policy that allows it. Serving `out/` from a CDN instead means the CDN
must send these headers — none of them survive a plain file upload. Set
`ENABLE_HSTS=true` only once TLS actually terminates in front of the app;
pinning `https` on a plain-http host makes it unreachable in that browser.

## Nightly jobs

Two maintenance tasks run inside the `api` container. Neither is optional at
any real volume — `analysis_cache` in particular grows without bound.

```cron
0  5 * * *  cd /srv/chessrabbit && docker compose exec -T api python -m app.services.sync_all
30 4 * * *  cd /srv/chessrabbit && docker compose exec -T api python -m app.services.maintenance
```

`maintenance` evicts aged and surplus engine-cache rows, drops auth tokens that can
no longer authenticate anything, forgets finished job payloads, and trims the Redis
presence set. Retention is tuned with `ANALYSIS_CACHE_TTL_DAYS`,
`ANALYSIS_CACHE_MAX_ROWS`, `JOB_RETENTION_DAYS` and `REVOKED_TOKEN_GRACE_DAYS`. It
is safe to run repeatedly and safe to interrupt: every step is chunked and
transactional.

## Database migrations

`db/migrations/*.sql` run automatically in filename order on a **fresh** Postgres
volume only. An existing database needs them applied by hand:

```bash
docker compose exec -T postgres psql -U chessrabbit -v ON_ERROR_STOP=1 \
  < db/migrations/012_hardening.sql
docker compose exec -T postgres psql -U chessrabbit -v ON_ERROR_STOP=1 \
  < db/migrations/013_admin_analytics.sql
```

`012` needs the `pg_trgm` extension, which requires a superuser the first time.

`013` adds the admin dashboard's tables. Three of them record history nothing was
writing before, so **every series on the dashboard starts the day this migration
is applied** — it cannot be backfilled. Apply it before you care about the
numbers, not when you first want to read them.

## Admin access

The admin dashboard lives at `/admin` and has its own login, separate from the
player app's. An ordinary signed-in session — even on an account with `is_admin`
— cannot reach any `/admin` route: the API issues a different token type for
`POST /admin/auth/login` and refuses player tokens everywhere below `/admin`.

```bash
python pipeline/make_admin.py you@example.com   # grant the flag
```

Admin sessions last `ADMIN_TOKEN_TTL_MIN` (default 60) and **cannot be
refreshed**. There is no revocation list, so that expiry is the only bound on a
leaked admin token — shorten it rather than lengthen it. Sign-in attempts are
rate limited to 5 per 15 minutes per IP and every one of them, successful or
not, lands in `admin_audit` along with every admin action.

## Why this is worth doing

It removes a Node process (and its memory) from the box at launch, and the
static bundle costs nothing to serve on any CDN free tier. This is
`SCALABILITY_PLAN.md` Phase 2 step 4, pulled forward — there is no reason to
wait for the Phase 2 trigger, since it is free at any scale.
