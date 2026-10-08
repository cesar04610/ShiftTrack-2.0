ALTER TABLE cuts ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE media_objects ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE media_objects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS media_objects_expiry ON media_objects (created_at) WHERE deleted_at IS NULL;
