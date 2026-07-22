-- Tactics puzzles from the Lichess open puzzle database (CC0).
-- Applied automatically on fresh docker volumes (initdb runs migrations in
-- filename order); apply manually on live DBs.

-- Each puzzle: a FEN plus a UCI solution line. Lichess convention - the first
-- move in `moves` is the opponent's setup move (played automatically); the
-- solver answers from move 2 onward.
CREATE TABLE puzzles (
  id          BIGSERIAL PRIMARY KEY,
  lichess_id  TEXT NOT NULL UNIQUE,
  fen         TEXT NOT NULL,
  moves       TEXT NOT NULL,              -- space-separated UCI, solution line
  rating      INT  NOT NULL,
  rating_dev  INT,
  popularity  INT,
  nb_plays    INT,
  themes      TEXT,                       -- space-separated Lichess themes
  game_url    TEXT,
  opening_tags TEXT
);
-- "give me a puzzle near rating N" is the hot path; also filter by theme.
CREATE INDEX puzzles_rating_idx ON puzzles(rating);

-- One row per solve attempt: powers stats, streaks, and "don't repeat recent".
CREATE TABLE puzzle_attempts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  puzzle_id   BIGINT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  solved      BOOLEAN NOT NULL,
  rating_before INT,
  rating_after  INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX puzzle_attempts_user_idx ON puzzle_attempts(user_id, created_at DESC);

-- A player's tactics rating, updated Elo-style after every attempt.
ALTER TABLE users ADD COLUMN puzzle_rating INT NOT NULL DEFAULT 1200;
