-- The index behind the opening-name filter on reference search.
-- Applied automatically on fresh docker volumes (initdb runs migrations in
-- filename order); apply manually on live DBs.
--
-- `GET /search/games` gained `opening=`, the last of the filters BLUEPRINT 8.4
-- specifies. ECO was already indexed and answers the same question precisely
-- ("B90"), but nobody searches that way from memory - they type "Najdorf".
--
-- Matching is infix, for the same reason the player names are: an opening
-- arrives as "Sicilian Defense: Najdorf Variation", and the part a person
-- remembers sits in the middle of it. A leading wildcard cannot use a btree,
-- so this is a trigram GIN index - the structure migration 012 added over the
-- player names for exactly this reason, applied to the one LIKE column that
-- was left without one.
--
-- pg_trgm is already installed by 012; the guard is here so this file also
-- applies to a database that only has 001.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Partial, matching every other reference-database index: search never looks
-- at games somebody owns, and excluding them keeps the index proportional to
-- the reference set rather than to every game on the platform.
CREATE INDEX games_opening_trgm_idx ON games
  USING gin (lower(opening) gin_trgm_ops) WHERE owner_id IS NULL;
