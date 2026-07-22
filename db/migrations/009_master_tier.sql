-- Third plan tier: master ($9.99/mo) above pro ($4.99/mo).
-- Applied automatically on fresh docker volumes; apply manually on live DBs.

ALTER TABLE users DROP CONSTRAINT users_plan_check;
ALTER TABLE users
  ADD CONSTRAINT users_plan_check
  CHECK (plan IN ('free', 'pro', 'master'));
