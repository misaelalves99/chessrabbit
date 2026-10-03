-- Admin dashboard: the tables the operator questions cannot be answered without.
-- Applied automatically on fresh docker volumes (initdb runs migrations in
-- filename order); apply manually on live DBs.
--
-- Three of these record history that was previously never written down. None of
-- them can be backfilled from what exists, so every series here starts on the
-- day this migration lands - which is a fact the dashboard states rather than
-- hides.

-- ============================================================
-- 1. Activity
-- ============================================================
-- "How many users are active?" had no answer: nothing recorded that a user did
-- anything. Redis carries the real-time view (who was seen in the last five
-- minutes) because that is a question about the present and does not need to
-- survive a restart. This table is the durable half: one row per user per day
-- they were seen, which is what DAU/WAU/MAU are counted from.
--
-- day leads the primary key so a window count is an index-only range scan
-- rather than a scan over every user's history.
CREATE TABLE daily_active_users (
  day     DATE   NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (day, user_id)
);

-- The signup series (GET /admin/overview) groups users by created_at over a
-- window. There was no index on it, so the smallest chart on the page cost a
-- sequential scan of the whole users table.
CREATE INDEX users_created_at_idx ON users(created_at);

-- ============================================================
-- 2. Subscription history
-- ============================================================
-- subscriptions held current state only: one row per user, overwritten in place
-- by each webhook. That answers "who is paying now" and nothing else - a
-- cancellation erased the fact that the subscription ever existed, so churn and
-- new-subscriptions-per-day were not computable at any price.
--
-- created_at backfills to updated_at for existing rows. That is the last time
-- the row changed, not when the subscription began, so pre-migration
-- subscriptions carry an APPROXIMATE start date. Rows written from here on are
-- exact.
ALTER TABLE subscriptions ADD COLUMN created_at  TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE subscriptions ADD COLUMN canceled_at TIMESTAMPTZ;

UPDATE subscriptions SET created_at = updated_at;

COMMENT ON COLUMN subscriptions.created_at IS
  'When the subscription began. Backfilled from updated_at by migration 013, so '
  'rows predating it are approximate.';

-- Append-only ledger, written by the Stripe webhook alongside the state update
-- it already performs. The webhook stays the only writer of users.plan; this
-- table just stops the history being thrown away.
--
-- amount_cents is the tier price at the time of the event, snapshotted rather
-- than joined: repricing a tier must not silently rewrite past revenue.
CREATE TABLE subscription_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'subscribed', 'renewed', 'status_changed',
                    'canceled', 'payment_failed', 'manual_override')),
  plan            TEXT NOT NULL,
  status          TEXT,
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  stripe_event_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_created_idx ON subscription_events(created_at);
CREATE INDEX subscription_events_user_idx    ON subscription_events(user_id, created_at DESC);

-- ============================================================
-- 3. Admin audit
-- ============================================================
-- The admin surface can now suspend an account and change a user's plan by
-- hand. Both are actions a customer may later dispute, and with more than one
-- admin there is otherwise no record of who did what. Every admin mutation -
-- and every sign-in attempt against /admin/auth/login, successful or not -
-- appends a row here.
--
-- admin_id is nullable and ON DELETE SET NULL: a failed login has no
-- authenticated actor, and removing an admin account must not erase the trail
-- of what it did.
CREATE TABLE admin_audit (
  id             BIGSERIAL PRIMARY KEY,
  admin_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip             TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit(created_at DESC);
