-- Studies: annotated positions that survive the browser they were made in.
-- Applied automatically on fresh docker volumes (initdb runs migrations in
-- filename order); apply manually on live DBs.
--
-- The move tree already knew how to branch, comment and export PGN, but every
-- line anyone drew lived in localStorage: one browser, thirty games, no way to
-- show it to anybody. These tables are the other half - the tree, kept where
-- it can be shared.
--
-- The unit of storage is PGN, not a bespoke node table. `pgn.ts` already reads
-- and writes movetext with variations, comments, NAGs and shape commands, and
-- a chapter is exactly what that produces. Two things follow from choosing it:
-- a chapter can be pasted into ChessBase or Lichess without a converter, and a
-- schema migration is never needed to store something the tree learns to hold.

-- ============================================================
-- 1. Studies
-- ============================================================
-- visibility is the whole sharing model:
--   private  - the owner and named members, nobody else
--   unlisted - anybody holding the slug (the "share link" case)
--   public   - same, and eligible to be listed
--
-- The slug is minted for every study rather than on first share, so making one
-- public is a single UPDATE and never has to fill in a column under a lock.
-- It is unguessable (32 url-safe chars) because for an unlisted study the slug
-- IS the credential.
CREATE TABLE studies (
  id          BIGSERIAL PRIMARY KEY,
  owner_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,
  description TEXT,
  visibility  TEXT   NOT NULL DEFAULT 'private'
                CHECK (visibility IN ('private', 'unlisted', 'public')),
  slug        TEXT   NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "My studies", the only listing that exists, ordered by most recently touched.
CREATE INDEX studies_owner_idx ON studies(owner_id, updated_at DESC);

-- ============================================================
-- 2. Chapters
-- ============================================================
-- A chapter is one board: a starting position, the moves and variations played
-- from it, and the prose around them.
--
-- starting_fen is stored even when it is the initial array, so replaying a
-- chapter never depends on the reader knowing which default we meant.
--
-- `version` is optimistic locking. Two people editing the same chapter is the
-- normal case for a shared study, and without this the second save silently
-- destroys the first: the tree is written whole, so a stale copy does not merge
-- badly, it merges not at all. Every write states the version it read, and the
-- server refuses one that has moved on (409) rather than taking it.
CREATE TABLE study_chapters (
  id           BIGSERIAL PRIMARY KEY,
  study_id     BIGINT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  name         TEXT   NOT NULL,
  description  TEXT,
  -- Movetext with variations. Headers live on the study and the chapter row,
  -- so what is kept here is the part the tree owns.
  pgn          TEXT   NOT NULL DEFAULT '',
  starting_fen TEXT   NOT NULL
                 DEFAULT 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  orientation  TEXT   NOT NULL DEFAULT 'white'
                 CHECK (orientation IN ('white', 'black')),
  -- Sparse on purpose: reordering rewrites one row's position, not the block
  -- below it.
  position     INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX study_chapters_study_idx ON study_chapters(study_id, position, id);

-- ============================================================
-- 3. Members
-- ============================================================
-- Who else may write. Reading is governed by `visibility`; this table is only
-- ever about the write side, which is why there is no 'viewer' role - a viewer
-- is somebody you sent the link to.
--
-- The owner is deliberately not a row here. Ownership comes off studies.owner_id
-- and cannot be revoked by deleting a membership.
CREATE TABLE study_members (
  study_id  BIGINT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT   NOT NULL DEFAULT 'contributor' CHECK (role IN ('contributor')),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (study_id, user_id)
);

-- "Studies shared with me" scans by user, so it needs the reverse of the PK.
CREATE INDEX study_members_user_idx ON study_members(user_id);
