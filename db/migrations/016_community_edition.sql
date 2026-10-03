-- No account has a subscription entitlement in the community edition.
-- Preserve old subscription/event tables as historical records for existing
-- installations. The application no longer reads or writes them.
ALTER TABLE users DROP COLUMN IF EXISTS plan;
