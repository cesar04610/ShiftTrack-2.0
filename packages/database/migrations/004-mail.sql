CREATE TABLE notification_outbox(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,source_key text NOT NULL,recipients text[] NOT NULL,subject text NOT NULL,body text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','retry_wait','needs_review')),attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,sent_at timestamptz,last_error text,PRIMARY KEY(branch_id,id),UNIQUE(branch_id,source_key));
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY branch_isolation ON notification_outbox USING (branch_id = nullif(current_setting('app.branch_id',true),'')::uuid) WITH CHECK (branch_id = nullif(current_setting('app.branch_id',true),'')::uuid);
ALTER TABLE alerts ADD COLUMN resolved boolean NOT NULL DEFAULT false;
