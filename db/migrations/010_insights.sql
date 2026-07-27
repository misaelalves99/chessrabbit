-- Player Insights (BLUEPRINT 3.x): aggregate stats across a player's own
-- games. Everything here is metadata the PGN already carries but we were
-- throwing away at import - without it we cannot answer "how do YOU do?",
-- only "how did this game go?".

-- Which side the owner played. NULL when we cannot tell (a manual PGN import
-- of somebody else's game, or a reference game). Every per-player statistic
-- filters on this, so games without it are excluded rather than guessed at.
ALTER TABLE games ADD COLUMN user_color CHAR(1)
  CHECK (user_color IN ('w', 'b'));

-- PGN Termination header, normalised at import to one of:
-- checkmate | resignation | timeout | abandoned | agreement | stalemate |
-- repetition | insufficient | fifty_move | other
ALTER TABLE games ADD COLUMN termination TEXT;

-- Raw PGN TimeControl ("300+2", "1/86400", "-") and the bucket we derive
-- from it: bullet | blitz | rapid | classical | correspondence | unknown
ALTER TABLE games ADD COLUMN time_control TEXT;
ALTER TABLE games ADD COLUMN time_class TEXT;

-- Full kickoff instant. `played_on` is a DATE and cannot answer "when in the
-- day do you play worst?"; UTCTime / StartTime give us the clock.
ALTER TABLE games ADD COLUMN played_at TIMESTAMPTZ;

-- Insights always scopes to one owner and walks their games newest-first.
CREATE INDEX games_owner_insights_idx
  ON games(owner_id, played_on DESC)
  WHERE owner_id IS NOT NULL;

-- Backfill colour for games already imported from a linked account: the
-- platform reports the player's canonical username, so an exact
-- case-insensitive match on White/Black is safe.
UPDATE games g
SET user_color = CASE
      WHEN lower(g.white) = lower(a.username) THEN 'w'
      WHEN lower(g.black) = lower(a.username) THEN 'b'
    END
FROM external_accounts a
WHERE g.owner_id = a.user_id
  AND g.user_color IS NULL
  AND lower(a.username) IN (lower(g.white), lower(g.black));

-- Date is all we have for older rows; midday UTC avoids timezone-shifting a
-- game onto the wrong day, and the time-of-day chart ignores these (it reads
-- only rows where played_at carries a real clock).
COMMENT ON COLUMN games.played_at IS
  'Game start instant from PGN UTCTime/StartTime. NULL for imports predating 010.';
