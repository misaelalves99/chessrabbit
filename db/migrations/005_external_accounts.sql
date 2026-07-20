-- Sprint 2 (3.3): auto-import games from Lichess / Chess.com.
-- One row per connected platform account; games gain an external_id so
-- repeated syncs never insert the same game twice.

CREATE TABLE external_accounts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform       TEXT NOT NULL,            -- 'lichess' | 'chesscom'
  username       TEXT NOT NULL,            -- canonical name as the platform reports it
  last_synced_at TIMESTAMPTZ,
  last_status    TEXT,                     -- 'ok' | error summary from the last sync
  games_imported INT NOT NULL DEFAULT 0,   -- lifetime counter
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform)
);

-- Platform game URL (e.g. https://lichess.org/AbCdEfGh). NULL for manual imports.
ALTER TABLE games ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX games_owner_external_idx
  ON games(owner_id, external_id) WHERE external_id IS NOT NULL;
