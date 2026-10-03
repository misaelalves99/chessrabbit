-- Hardening pass: token-theft detection, cache eviction, and the indexes the
-- name searches and the blunder sync were missing.
-- Applied automatically on fresh docker volumes (initdb runs migrations in
-- filename order); apply manually on live DBs.

-- ============================================================
-- 1. Player-name search
-- ============================================================
-- Both the reference-database search and the OTB name picker match with
-- `lower(white) LIKE '%needle%'`. A leading wildcard cannot use the
-- text_pattern_ops btree from 001, so every lookup fell back to a sequential
-- scan of all 52k reference games - ~950ms for one keystroke of an
-- autocomplete. Trigram GIN indexes are the structure that answers an
-- infix LIKE, and they serve both the search endpoint and the picker.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX games_white_trgm_idx ON games
  USING gin (lower(white) gin_trgm_ops) WHERE owner_id IS NULL;
CREATE INDEX games_black_trgm_idx ON games
  USING gin (lower(black) gin_trgm_ops) WHERE owner_id IS NULL;

-- The same search exists over a user's own games (GET /games?q=). Scoped by
-- owner_id it is small, but the index costs little and keeps the plan stable
-- for accounts that import tens of thousands of games.
CREATE INDEX games_owner_white_trgm_idx ON games
  USING gin (lower(white) gin_trgm_ops) WHERE owner_id IS NOT NULL;
CREATE INDEX games_owner_black_trgm_idx ON games
  USING gin (lower(black) gin_trgm_ops) WHERE owner_id IS NOT NULL;

-- ============================================================
-- 2. Blunder sync
-- ============================================================
-- POST /training/blunders/sync selects a user's tagged mistakes across every
-- game they own. The only annotations index leads with game_id, so a
-- user-scoped filter could not use it. Partial: the sync only ever wants rows
-- that carry an engine mistake NAG and a best move.
CREATE INDEX annotations_user_mistakes_idx ON annotations(user_id, game_id, ply)
  WHERE nag IN (2, 4) AND best_uci IS NOT NULL;

-- ============================================================
-- 3. Refresh-token theft detection
-- ============================================================
-- Refresh tokens rotate, so a stolen token stops working as soon as the real
-- user refreshes - but presenting an already-revoked token was simply a 401.
-- That attempt is the one clear signal a token leaked: a token is used twice
-- only when someone kept a copy. Grouping a rotation chain into a family lets
-- the reuse revoke every descendant, which logs the thief AND the victim out
-- and forces a fresh login.
--
-- family_id is the id of the chain's first token. Backfilled to each row's own
-- id, so pre-existing sessions become single-member families and keep working.
ALTER TABLE refresh_tokens ADD COLUMN family_id BIGINT;
UPDATE refresh_tokens SET family_id = id WHERE family_id IS NULL;
ALTER TABLE refresh_tokens ALTER COLUMN family_id SET NOT NULL;

CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);

COMMENT ON COLUMN refresh_tokens.family_id IS
  'Root token id of this rotation chain. Reusing any revoked member revokes '
  'the whole family - see routers/auth.py.';

-- ============================================================
-- 4. Engine-cache eviction
-- ============================================================
-- analysis_cache grows without bound: every position anyone analyses at a new
-- depth is a row that is never removed, and it is already the largest
-- contributor to db_size_mb on /admin/stats. Eviction is by age, so the sweep
-- needs to find old rows without reading the table.
CREATE INDEX analysis_cache_created_idx ON analysis_cache(created_at);
