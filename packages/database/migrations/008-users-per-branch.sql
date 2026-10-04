ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users DROP CONSTRAINT users_username_key;
CREATE UNIQUE INDEX users_live_username_per_branch
 ON users (username, (coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid)))
 WHERE deleted_at IS NULL;
