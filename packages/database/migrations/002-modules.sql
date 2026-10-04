ALTER TABLE branches ADD COLUMN pause_token uuid, ADD COLUMN pause_ack boolean NOT NULL DEFAULT false;
CREATE TABLE task_catalog(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,title text NOT NULL,description text NOT NULL DEFAULT '',priority text NOT NULL DEFAULT 'normal',active boolean NOT NULL DEFAULT true,PRIMARY KEY(branch_id,id));
CREATE TABLE task_assignments(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,catalog_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),recurrence text NOT NULL CHECK(recurrence IN ('once','daily','weekly')),start_date date NOT NULL,weekdays integer[] NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true,PRIMARY KEY(branch_id,id),FOREIGN KEY(branch_id,catalog_id) REFERENCES task_catalog(branch_id,id));
ALTER TABLE tasks ADD COLUMN assignment_id uuid, ADD COLUMN media_id uuid;
ALTER TABLE tasks ADD FOREIGN KEY(branch_id,assignment_id) REFERENCES task_assignments(branch_id,id);
CREATE UNIQUE INDEX task_daily_instance ON tasks(branch_id,assignment_id,due_date) WHERE assignment_id IS NOT NULL;
CREATE TABLE media_objects(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,task_id uuid NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),sha256 text NOT NULL,size integer NOT NULL CHECK(size>0 AND size<=5242880),content_type text NOT NULL,object_path text NOT NULL,PRIMARY KEY(branch_id,id),FOREIGN KEY(branch_id,task_id) REFERENCES tasks(branch_id,id));
CREATE TABLE supplier_corrections(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,ticket_id uuid NOT NULL,type text NOT NULL CHECK(type IN ('documentary','refund')),amount_cents bigint NOT NULL CHECK(amount_cents>0),treasury_effect_cents bigint NOT NULL,supplier_cash_effect_cents bigint NOT NULL,reason text NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),occurred_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(branch_id,id),FOREIGN KEY(branch_id,ticket_id) REFERENCES tickets(branch_id,id));
CREATE TABLE alert_settings(branch_id uuid PRIMARY KEY REFERENCES branches(id),absence_tolerance_minutes integer NOT NULL DEFAULT 15,cut_delay_minutes integer NOT NULL DEFAULT 30,recipients text[] NOT NULL DEFAULT '{}',email_enabled boolean NOT NULL DEFAULT false);
CREATE TABLE alerts(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,type text NOT NULL,message text NOT NULL,source_key text NOT NULL,seen boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(branch_id,id),UNIQUE(branch_id,type,source_key));
CREATE TABLE expense_categories(branch_id uuid NOT NULL REFERENCES branches(id),id uuid NOT NULL,name text NOT NULL,active boolean NOT NULL DEFAULT true,PRIMARY KEY(branch_id,id),UNIQUE(branch_id,name));
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT unnest(ARRAY['task_catalog','task_assignments','media_objects','supplier_corrections','alert_settings','alerts','expense_categories']) LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY branch_isolation ON %I USING (branch_id = nullif(current_setting(''app.branch_id'',true),'''')::uuid) WITH CHECK (branch_id = nullif(current_setting(''app.branch_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
