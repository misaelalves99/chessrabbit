-- Admin capabilities + account suspension.

ALTER TABLE users ADD COLUMN is_admin     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;

-- Suspended users keep their data but cannot authenticate.
CREATE INDEX users_suspended_idx ON users(suspended_at) WHERE suspended_at IS NOT NULL;
