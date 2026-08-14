# Security

What the code enforces, what it deliberately does not, and what you have to do
by hand before this takes real traffic.

## Before launch — things only you can do

### 1. Rotate every credential

Nothing in this repository is a secret, and git remembers what was committed
even after it is edited out. Treat all of the following as public:

| Value | Where it appears | Do this |
|---|---|---|
| `devpassword` | `docker-compose.yml`, `.env.example`, `pipeline/*.py` defaults | New Postgres password, set via `POSTGRES_PASSWORD` and `DATABASE_URL` |
| `dev-secret-change-me` | `apps/api/app/core/config.py` (`DEV_JWT_SECRET`) | New `JWT_SECRET`: `openssl rand -hex 32`. Rotating it signs every live session out, which is the point |
| Demo account passwords | `pipeline/seed_demo_users.py` | Never seed them outside development; delete any that exist |

If a real key was ever committed — a Stripe secret, an email provider key —
rotating it in the provider's dashboard is the only fix that works. Removing it
in a later commit does not: the old object is still in the history, in every
clone, and in every fork. Rotate first, clean history second (or never).

### 2. Fill in the required environment

The API refuses to start with `ENVIRONMENT=production` unless all of these hold
(`apps/api/app/core/config.py`):

- `JWT_SECRET` is set, is not the development placeholder, and is ≥ 32 chars
- `APP_BASE_URL` is `https://`
- `EMAIL_API_KEY` is set — without a provider the mailer would print reset
  links to the log, which it refuses to do in production
- `DATABASE_URL` no longer contains `devpassword`

It logs a warning, but still starts, when `DATABASE_URL` or `REDIS_URL` look
like they cross a network without TLS.

### 3. Close the infrastructure

- **Do not publish Postgres or Redis.** `docker-compose.yml` binds both to
  `127.0.0.1`. Docker writes its own iptables rules, so a `"5433:5432"`-style
  mapping is reachable from the internet even with `ufw` denying it. Redis here
  has no password; an exposed one is remote code execution on many builds.
- **Put TLS in front of the API**, then set `ENABLE_HSTS=true` for the web tier.
- **Set `TRUST_PROXY_HEADERS=true` only once a proxy you control overwrites
  `X-Forwarded-For`.** On without a proxy, a client forges a new identity per
  request and walks around the login rate limit.
- **Use `?ssl=require` (asyncpg) and `rediss://`** for managed backends.
- Give Redis a password.

### 4. Fill in the legal placeholders

`apps/web/src/lib/legal.ts` ships `TODO` values for your entity, address,
jurisdiction and support address. They are rendered as visible TODOs on
`/privacy` and `/terms`. Fill them in before taking payment.

## What the code enforces

### Authentication

- Argon2 password hashing (`argon2-cffi`, default parameters). Plaintext
  passwords exist only as a function argument on the way into the hasher.
- Access tokens are 15-minute JWTs; refresh tokens are opaque, rotated on every
  use, and stored only as SHA-256 hashes. Presenting a rotated token revokes the
  whole family — that is theft detection, not just rotation.
- Signing out revokes the refresh token in the database *and* adds the access
  token's `jti` to a Redis revocation list for its remaining lifetime
  (`app/core/revocation.py`). The list fails open if Redis is down; the exposure
  is bounded by the 15-minute token lifetime.
- Password reset tokens: single-use, bound to one user, 15 minutes, and
  requesting a new one invalidates any older unused ones. A completed reset
  revokes every session.
- `/auth/forgot` always returns 204, and `/auth/login` hashes a dummy password
  for unknown addresses, so neither endpoint reveals whether an account exists.
  **`/auth/register` still returns 409 for a taken address** — see the known
  gaps below.

### Authorization

- Every user-scoped query filters on the id in the token. No endpoint takes a
  user id from the client except the admin routes, which require an admin token.
- The admin surface uses a **separate token type** (`type: "admin"`) minted by
  its own login. A player session cannot reach it even for an account carrying
  `is_admin`, so an XSS in the player app does not inherit the dashboard.
  `is_admin`, suspension and deletion are re-read from the database on every
  admin request, so revoking the flag takes effect immediately.
- Study visibility: `private` is owner and members only; `unlisted` is readable
  **only via its unguessable slug**, never by its sequential id; `public` is
  readable either way.

### Rate limits (per IP unless noted)

| Endpoint | Limit |
|---|---|
| `/auth/login` | 5 / minute |
| `/admin/auth/login` | 5 / 15 minutes |
| `/auth/register` | 10 / hour |
| `/auth/forgot` | 3 / hour |
| `/auth/reset` | 10 / 5 minutes |
| `/auth/refresh` | 60 / minute |
| Expensive authenticated work | per **account**, not per IP |

Live analysis sockets are capped per account by plan, and engine analysis is
metered daily on the free tier over both REST and WebSocket.

### Input and output

- No raw SQL is built from user input. Every query is parameterised; the two
  places that interpolate SQL text (`services/insights.py`,
  `services/admin_analytics.py`) interpolate server-owned clause fragments with
  bound parameters, never values.
- `LIKE` metacharacters are escaped in every search box, so `%` searches for a
  percent sign instead of scanning the whole reference database.
- React escapes all rendered output and the app uses no `dangerouslySetInnerHTML`,
  no `innerHTML`, and no `eval`.
- Unhandled errors return `{"code": "internal_error", "correlation_id": "..."}`
  and nothing else. The traceback goes to the server log under that id.
- `/docs`, `/redoc` and `/openapi.json` are withdrawn in production.
- `/health` returns only `{"status": ...}` to anonymous callers; dependency
  detail and version need an admin token.

### Payments

- Prices live in the server's environment as Stripe price ids. The client sends
  only `"monthly"` or `"yearly"` — there is no amount in any request body to
  tamper with.
- Webhooks are verified (HMAC-SHA256, constant-time, 5-minute timestamp
  tolerance) before the body is parsed, made idempotent by an insert-first
  `processed_webhook_events` row, and only grant a plan when Stripe reports the
  payment as actually paid.

### Personal data

- Collected: email, password (hashed), display name, linked platform usernames,
  client IP (rate-limit counters and admin audit rows), and the chess games the
  user imports.
- Sent to third parties: the email address and message body to the email
  provider; email, Stripe customer/subscription ids to Stripe. Nothing else
  leaves. There is no analytics SDK, no error-tracking SDK, and no AI API.
- Logs identify users by id. Where a human needs to recognise an address it is
  masked (`a***e@example.com`) — see `app/core/redact.py`. The `admin_audit`
  table keeps full values on purpose; it is inside the database and subject to
  the same retention and deletion rules as everything else.
- `GET /me/export` returns everything held about the caller. `DELETE /me` soft
  deletes; `pipeline/purge.py` hard deletes after the retention window, and
  `ON DELETE CASCADE` takes the games, tokens, jobs and annotations with it.

## Known gaps — accepted, not fixed

These are deliberate. Each is a real tradeoff rather than an oversight.

1. **Tokens live in `localStorage`, not `httpOnly` cookies.** The web tier is a
   static export with no server of its own, so cookie auth would mean
   cross-site cookies (`SameSite=None; Secure`) plus CSRF tokens on every
   mutation. Consequence: an XSS anywhere in the bundle can steal a session —
   including an admin session while an admin is signed in, which is the part
   the separate admin token type does *not* protect against. The mitigations
   are the strict CSP, React's escaping, and short token lifetimes.
2. **The web CSP allows `'unsafe-inline'` for scripts.** A Next static export
   ships its hydration payload as an inline `<script>` with no nonce, and there
   is no server render pass in which to add one. Moving to a hosting tier that
   can inject nonces (or to SSR) is what removes this.
3. **`/auth/register` reveals whether an address is registered** (409
   `email_taken`). The alternative — accept the signup and email the existing
   owner instead — is better practice and a materially different signup flow.
4. **The rate limiter fails open when Redis is down.** A Redis outage would
   otherwise become a sign-in outage. Set `AUTH_RATELIMIT_FAIL_CLOSED=true` to
   invert that for credential endpoints once Redis is redundant.
5. **Study contributors can see each other's email addresses.** You add
   contributors *by* email, so the list would be hard to use otherwise.
6. **Admin tokens cannot be revoked once leaked without a sign-out.** There is
   no admin session table; expiry (`ADMIN_TOKEN_TTL_MIN`, default 60) is the
   bound. Shorten it rather than lengthen it.

## Reporting

Nothing here is a substitute for a penetration test before launch. If you find
something, fix it and add a regression to `apps/api/tests/test_security.py` —
every control in this document that can fail silently has one there.
