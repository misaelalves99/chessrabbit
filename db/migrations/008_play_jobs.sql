-- Allow "play" analysis jobs (one engine move for play-vs-computer).
-- Applied automatically on fresh docker volumes; apply manually on live DBs.

ALTER TABLE analysis_jobs DROP CONSTRAINT analysis_jobs_kind_check;
ALTER TABLE analysis_jobs
  ADD CONSTRAINT analysis_jobs_kind_check
  CHECK (kind IN ('position', 'full_game', 'play'));
