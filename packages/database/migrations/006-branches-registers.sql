ALTER TABLE branches ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE branches ADD COLUMN register_count integer NOT NULL DEFAULT 1 CHECK (register_count BETWEEN 1 AND 100);
UPDATE branches SET register_count=GREATEST(supplier_register,COALESCE((SELECT max(register_number) FROM cuts WHERE cuts.branch_id=branches.id),1));
ALTER TABLE branches ADD CONSTRAINT supplier_register_in_range CHECK (supplier_register<=register_count);
CREATE TABLE register_leases (
 branch_id uuid NOT NULL REFERENCES branches(id),
 register_number integer NOT NULL CHECK(register_number>0),
 session_hash text NOT NULL UNIQUE REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(branch_id,register_number)
);
ALTER TABLE register_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY branch_isolation ON register_leases USING (branch_id=nullif(current_setting('app.branch_id',true),'')::uuid) WITH CHECK (branch_id=nullif(current_setting('app.branch_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shifttrack_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON register_leases TO shifttrack_app;
 END IF;
END $$;
