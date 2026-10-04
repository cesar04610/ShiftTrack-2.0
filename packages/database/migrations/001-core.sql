CREATE TABLE branches (
 id uuid PRIMARY KEY, name text NOT NULL, timezone text NOT NULL DEFAULT 'America/Mazatlan',
 supplier_register integer NOT NULL DEFAULT 1 CHECK(supplier_register>0), device_id uuid,
 assignment_epoch integer NOT NULL DEFAULT 1, balance_cents bigint NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 0, device_seq bigint NOT NULL DEFAULT 0,
 active_shift uuid, last_closed_shift uuid, initialized boolean NOT NULL DEFAULT false
);
CREATE TABLE users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, name text NOT NULL, role text NOT NULL CHECK(role IN ('superadmin','admin','employee')),
 branch_id uuid REFERENCES branches(id), active boolean NOT NULL DEFAULT true, auth_version integer NOT NULL DEFAULT 1,
 CHECK(role='superadmin' OR branch_id IS NOT NULL), UNIQUE(branch_id,id)
);
CREATE TABLE password_credentials(user_id uuid PRIMARY KEY REFERENCES users(id), hash text NOT NULL);
CREATE TABLE server_keys(id integer PRIMARY KEY CHECK(id=1), private_jwk jsonb NOT NULL, public_jwk jsonb NOT NULL);
CREATE TABLE devices(id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), name text NOT NULL, public_key jsonb NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(branch_id,id));
ALTER TABLE branches ADD CONSTRAINT branches_device_fk FOREIGN KEY(id,device_id) REFERENCES devices(branch_id,id);
CREATE TABLE grants(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), device_id uuid NOT NULL REFERENCES devices(id), branch_id uuid NOT NULL REFERENCES branches(id), auth_version integer NOT NULL, body jsonb NOT NULL, signature text NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE device_challenges(id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id), nonce text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE device_sessions(token_hash text PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id), expires_at timestamptz NOT NULL);
CREATE TABLE suppliers(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,company text NOT NULL, contact text NOT NULL DEFAULT '',active boolean NOT NULL DEFAULT true, PRIMARY KEY(branch_id,id));
CREATE TABLE supplier_shifts(branch_id uuid NOT NULL REFERENCES branches(id), id uuid NOT NULL, actor_user_id uuid NOT NULL REFERENCES users(id), business_date date NOT NULL, opened_at timestamptz NOT NULL, closed_at timestamptz, opening_cents bigint NOT NULL, expected_cents bigint, counted_cents bigint, difference_cents bigint, previous_close_id uuid, PRIMARY KEY(branch_id,id), FOREIGN KEY(branch_id,previous_close_id) REFERENCES supplier_shifts(branch_id,id));
CREATE UNIQUE INDEX one_open_shift ON supplier_shifts(branch_id) WHERE closed_at IS NULL;
CREATE TABLE tickets(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,supplier_id uuid NOT NULL,shift_id uuid NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),amount_cents bigint NOT NULL CHECK(amount_cents>0),note text NOT NULL DEFAULT '',occurred_at timestamptz NOT NULL,voided boolean NOT NULL DEFAULT false,void_reason text,PRIMARY KEY(branch_id,id),FOREIGN KEY(branch_id,supplier_id) REFERENCES suppliers(branch_id,id),FOREIGN KEY(branch_id,shift_id) REFERENCES supplier_shifts(branch_id,id));
CREATE TABLE supplier_events(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,type text NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),amount_cents bigint,occurred_at timestamptz NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(branch_id,id));
CREATE TABLE clock_records(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),business_date date NOT NULL,clock_in timestamptz NOT NULL,clock_out timestamptz,PRIMARY KEY(branch_id,id));
CREATE UNIQUE INDEX one_open_clock ON clock_records(branch_id,user_id,business_date) WHERE clock_out IS NULL;
CREATE TABLE schedules(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),business_date date NOT NULL,start_time time NOT NULL,end_time time NOT NULL,CHECK(end_time>start_time),PRIMARY KEY(branch_id,id), UNIQUE(branch_id,user_id,business_date,start_time));
CREATE TABLE tasks(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),title text NOT NULL,due_date date NOT NULL,priority text NOT NULL DEFAULT 'normal',completed_at timestamptz,note text NOT NULL DEFAULT '',PRIMARY KEY(branch_id,id));
CREATE TABLE shortages(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),product text NOT NULL,note text NOT NULL DEFAULT '',occurred_at timestamptz NOT NULL,resolved boolean NOT NULL DEFAULT false,PRIMARY KEY(branch_id,id));
CREATE TABLE cuts(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),register_number integer NOT NULL CHECK(register_number>0),business_date date NOT NULL,label text NOT NULL CHECK(label IN ('Mañana','Tarde')),sales_cents bigint NOT NULL,card_cents bigint NOT NULL,declared_cents bigint NOT NULL,expected_cents bigint NOT NULL,difference_cents bigint NOT NULL,occurred_at timestamptz NOT NULL,PRIMARY KEY(branch_id,id),UNIQUE(branch_id,user_id,business_date,label));
CREATE TABLE treasury_entries(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,source_id uuid NOT NULL,kind text NOT NULL,cash_cents bigint NOT NULL DEFAULT 0,bank_cents bigint NOT NULL DEFAULT 0,note text NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),occurred_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(branch_id,id),UNIQUE(branch_id,source_id,kind));
CREATE TABLE processed_operations(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(branch_id,id));
CREATE TABLE audit_events(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,actor_user_id uuid REFERENCES users(id),action text NOT NULL,payload jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(branch_id,id));
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT unnest(ARRAY['suppliers','supplier_shifts','tickets','supplier_events','clock_records','schedules','tasks','shortages','cuts','treasury_entries','processed_operations','audit_events']) LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY branch_isolation ON %I USING (branch_id = nullif(current_setting(''app.branch_id'',true),'''')::uuid) WITH CHECK (branch_id = nullif(current_setting(''app.branch_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
