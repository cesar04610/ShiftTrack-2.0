-- Tareas por configuración: cada caja y turno (completo o medio) tiene su lista de tareas,
-- que se asigna sola a quien trabaja ese turno en esa caja.
CREATE TABLE task_setup_items(
 branch_id uuid NOT NULL REFERENCES branches(id),
 id uuid NOT NULL,
 shift text NOT NULL CHECK(shift IN ('morning','afternoon')),
 half boolean NOT NULL DEFAULT false,
 register_number integer NOT NULL CHECK(register_number>0),
 title text NOT NULL,
 weekdays integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(branch_id,id)
);
CREATE INDEX task_setup_items_config ON task_setup_items(branch_id,register_number,shift,half) WHERE active;
ALTER TABLE task_setup_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_setup_items FORCE ROW LEVEL SECURITY;
CREATE POLICY branch_isolation ON task_setup_items USING (branch_id=nullif(current_setting('app.branch_id',true),'')::uuid) WITH CHECK (branch_id=nullif(current_setting('app.branch_id',true),'')::uuid);
-- Cada tarea generada recuerda de qué configuración salió, aunque la lista cambie después.
ALTER TABLE tasks ADD COLUMN setup_item_id uuid, ADD COLUMN shift text, ADD COLUMN half boolean, ADD COLUMN register_number integer;
ALTER TABLE tasks ADD FOREIGN KEY(branch_id,setup_item_id) REFERENCES task_setup_items(branch_id,id);
CREATE UNIQUE INDEX task_setup_instance ON tasks(branch_id,setup_item_id,user_id,due_date) WHERE setup_item_id IS NOT NULL;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shifttrack_app') THEN
  GRANT SELECT,INSERT,UPDATE ON task_setup_items TO shifttrack_app;
  -- Solo se quitan tareas pendientes sin evidencia (caja equivocada, tarea extra capturada por error).
  GRANT DELETE ON tasks TO shifttrack_app;
 END IF;
END $$;
