-- ChessRabbit initial schema
-- Implements BLUEPRINT.md Section 7. Runs automatically on first postgres boot.

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================
-- 7.1 Users & auth
-- ============================================================
CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  email          CITEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL DEFAULT '',
  plan           TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE TABLE refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id) WHERE NOT revoked;
CREATE INDEX refresh_tokens_hash_idx ON refresh_tokens(token_hash);

CREATE TABLE email_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX email_tokens_hash_idx ON email_tokens(token_hash);

-- ============================================================
-- 7.2 Billing (mirror of Stripe truth)
-- ============================================================
CREATE TABLE subscriptions (
  id                     BIGSERIAL PRIMARY KEY,
  user_id                BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL,
  current_period_end     TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_stripe_cust_idx ON subscriptions(stripe_customer_id);

-- Idempotency guard for Stripe webhooks
CREATE TABLE processed_webhook_events (
  event_id     TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 7.3 Games (user games AND public reference DB in one table)
-- ============================================================
CREATE TABLE games (
  id         BIGSERIAL PRIMARY KEY,
  owner_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,  -- NULL = public reference game
  source     TEXT NOT NULL DEFAULT 'user',
  white      TEXT NOT NULL DEFAULT '',
  black      TEXT NOT NULL DEFAULT '',
  white_elo  SMALLINT,
  black_elo  SMALLINT,
  result     TEXT NOT NULL DEFAULT '*' CHECK (result IN ('1-0', '0-1', '1/2-1/2', '*')),
  event      TEXT NOT NULL DEFAULT '',
  site       TEXT NOT NULL DEFAULT '',
  played_on  DATE,
  eco        CHAR(3),
  opening    TEXT,
  ply_count  SMALLINT NOT NULL DEFAULT 0,
  movetext   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX games_owner_idx ON games(owner_id, created_at DESC) WHERE owner_id IS NOT NULL;
CREATE INDEX games_white_idx ON games (lower(white) text_pattern_ops) WHERE owner_id IS NULL;
CREATE INDEX games_black_idx ON games (lower(black) text_pattern_ops) WHERE owner_id IS NULL;
CREATE INDEX games_eco_idx   ON games(eco) WHERE owner_id IS NULL;
CREATE INDEX games_elo_idx   ON games(GREATEST(white_elo, black_elo) DESC) WHERE owner_id IS NULL;
CREATE INDEX games_date_idx  ON games(played_on DESC) WHERE owner_id IS NULL;

-- ============================================================
-- 7.4 Position index (powers position search + opening explorer)
-- ============================================================
CREATE TABLE game_positions (
  game_id  BIGINT   NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply      SMALLINT NOT NULL,
  zobrist  BIGINT   NOT NULL,
  move_uci TEXT     NOT NULL,
  PRIMARY KEY (game_id, ply)
);
CREATE INDEX game_positions_zobrist_idx ON game_positions(zobrist);

-- ============================================================
-- 7.5 Precomputed opening explorer
-- ============================================================
CREATE TABLE opening_tree (
  zobrist    BIGINT   NOT NULL,
  move_uci   TEXT     NOT NULL,
  games      INT      NOT NULL,
  white_wins INT      NOT NULL,
  draws      INT      NOT NULL,
  black_wins INT      NOT NULL,
  avg_elo    SMALLINT,
  PRIMARY KEY (zobrist, move_uci)
);

-- ============================================================
-- 7.6 Engine cache & jobs
-- ============================================================
CREATE TABLE analysis_cache (
  zobrist        BIGINT   NOT NULL,
  fen            TEXT     NOT NULL,
  engine_version TEXT     NOT NULL,
  depth          SMALLINT NOT NULL,
  multipv        JSONB    NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (zobrist, engine_version)
);
CREATE INDEX analysis_cache_depth_idx ON analysis_cache(zobrist, depth DESC);

CREATE TABLE analysis_jobs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id     BIGINT REFERENCES games(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('position', 'full_game')),
  params      JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  result      JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX analysis_jobs_user_idx   ON analysis_jobs(user_id, created_at DESC);
CREATE INDEX analysis_jobs_status_idx ON analysis_jobs(status) WHERE status IN ('queued', 'running');

-- ============================================================
-- 7.7 Annotations & collections
-- ============================================================
CREATE TABLE annotations (
  id      BIGSERIAL PRIMARY KEY,
  game_id BIGINT   NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id BIGINT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ply     SMALLINT NOT NULL,
  nag     SMALLINT,
  comment TEXT,
  eval_cp INT,
  UNIQUE (game_id, user_id, ply)
);
CREATE INDEX annotations_game_idx ON annotations(game_id, user_id);

CREATE TABLE collections (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX collections_user_idx ON collections(user_id);

CREATE TABLE collection_games (
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  game_id       BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, game_id)
);

-- ============================================================
-- 7.8 Usage metering (free-tier limits)
-- ============================================================
CREATE TABLE usage_daily (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      DATE   NOT NULL,
  analyses INT    NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
