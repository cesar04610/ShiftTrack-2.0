CREATE TABLE alert_log(
 branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('late','absent','early_exit','cut_difference','missing_cut','task_incomplete','supplier_difference')),
 user_id uuid,
 business_date date,
 message text NOT NULL,
 amount_cents bigint,
 source_key text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(branch_id,id),
 UNIQUE(branch_id,source_key)
);
CREATE INDEX alert_log_recent ON alert_log (branch_id, occurred_at DESC);
ALTER TABLE alert_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_log FORCE ROW LEVEL SECURITY;
CREATE POLICY branch_isolation ON alert_log USING (branch_id=nullif(current_setting('app.branch_id',true),'')::uuid) WITH CHECK (branch_id=nullif(current_setting('app.branch_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shifttrack_app') THEN
  GRANT SELECT,INSERT,UPDATE ON alert_log TO shifttrack_app;
 END IF;
END $$;
