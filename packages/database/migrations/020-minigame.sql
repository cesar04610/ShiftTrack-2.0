-- Minijuego "Hora Pico": historial y mejores puntuaciones por sucursal y modo.
-- Independiente de la operación financiera; conserva el aislamiento entre sucursales y el historial de usuarios.
CREATE TABLE minigame_scores(
 branch_id uuid NOT NULL REFERENCES branches(id),
 id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id),
 mode text NOT NULL CHECK(mode IN ('shift','endless')),
 score integer NOT NULL CHECK(score>=0 AND score<=500000),
 customers_served integer NOT NULL DEFAULT 0 CHECK(customers_served>=0 AND customers_served<=10000),
 sales_cents bigint NOT NULL DEFAULT 0 CHECK(sales_cents>=0),
 grade text NOT NULL DEFAULT '' CHECK(grade IN ('','S','A','B','C','D')),
 duration_seconds integer NOT NULL DEFAULT 0 CHECK(duration_seconds>=0 AND duration_seconds<=86400),
 max_combo integer NOT NULL DEFAULT 1 CHECK(max_combo>=1 AND max_combo<=100),
 suppliers_received integer NOT NULL DEFAULT 0 CHECK(suppliers_received>=0 AND suppliers_received<=1000),
 played_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(branch_id,id)
);
CREATE INDEX minigame_scores_leaderboard ON minigame_scores(branch_id,mode,score DESC,played_at ASC);
CREATE INDEX minigame_scores_by_user ON minigame_scores(branch_id,user_id,mode,score DESC);
ALTER TABLE minigame_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE minigame_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY branch_isolation ON minigame_scores
 USING (branch_id = nullif(current_setting('app.branch_id',true),'')::uuid)
 WITH CHECK (branch_id = nullif(current_setting('app.branch_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shifttrack_app') THEN
  GRANT SELECT,INSERT,UPDATE ON minigame_scores TO shifttrack_app;
 END IF;
END $$;
