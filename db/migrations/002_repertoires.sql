-- Repertoire trainer: opening lines + spaced-repetition cards.
-- BLUEPRINT.md Phase 4a. Applied automatically on fresh docker volumes
-- (initdb runs migrations in filename order); apply manually on live DBs.

CREATE TABLE repertoires (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL CHECK (color IN ('white', 'black')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX repertoires_user_idx ON repertoires(user_id);

-- One card per (repertoire, position). The expected move is the FIRST
-- variation for the owner's color at that node; opponent branches all expand.
CREATE TABLE training_cards (
  id            BIGSERIAL PRIMARY KEY,
  repertoire_id BIGINT NOT NULL REFERENCES repertoires(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zobrist       BIGINT NOT NULL,
  fen           TEXT   NOT NULL,
  expected_uci  TEXT   NOT NULL,
  expected_san  TEXT   NOT NULL,
  -- SM-2-lite scheduling state
  ease          REAL    NOT NULL DEFAULT 2.5,
  interval_days REAL    NOT NULL DEFAULT 0,
  due_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reps          INT     NOT NULL DEFAULT 0,
  lapses        INT     NOT NULL DEFAULT 0,
  UNIQUE (repertoire_id, zobrist)
);
CREATE INDEX training_cards_due_idx ON training_cards(user_id, due_at);
