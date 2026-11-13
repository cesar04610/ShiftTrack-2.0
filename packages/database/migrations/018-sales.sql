-- Ventas de respaldo: catálogo importado de SICAR y ventas capturadas en Mostrador cuando SICAR falla.
-- Las ventas son informativas: no mueven Caja general; el dinero entra con el corte del turno.
CREATE TABLE products(
 branch_id uuid NOT NULL REFERENCES branches(id),
 id uuid NOT NULL,
 clave text NOT NULL,
 clave_alterna text NOT NULL DEFAULT '',
 description text NOT NULL,
 -- Precio al público, con impuestos incluidos.
 price_cents bigint NOT NULL CHECK(price_cents>=0),
 bulk boolean NOT NULL DEFAULT false,
 -- Un producto que ya no viene en la importación se desactiva; no se borra porque hay ventas que lo citan.
 active boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(branch_id,id)
);
CREATE UNIQUE INDEX products_clave ON products(branch_id,lower(clave));
-- La versión cambia con cada importación; los equipos la comparan para descargar el catálogo nuevo.
CREATE TABLE product_catalogs(
 branch_id uuid PRIMARY KEY REFERENCES branches(id),
 version bigint NOT NULL DEFAULT 0,
 product_count integer NOT NULL DEFAULT 0,
 imported_at timestamptz NOT NULL DEFAULT now(),
 imported_by uuid REFERENCES users(id)
);
CREATE TABLE sales(
 branch_id uuid NOT NULL REFERENCES branches(id),
 id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id),
 register_number integer NOT NULL CHECK(register_number>0),
 clock_record_id uuid,
 payment text NOT NULL CHECK(payment IN ('cash','card')),
 total_cents bigint NOT NULL CHECK(total_cents>0),
 received_cents bigint NOT NULL CHECK(received_cents>=total_cents),
 change_cents bigint NOT NULL CHECK(change_cents>=0),
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(branch_id,id)
);
CREATE INDEX sales_by_time ON sales(branch_id,occurred_at);
CREATE INDEX sales_by_user ON sales(branch_id,user_id,occurred_at);
-- Cada renglón guarda clave, descripción y precio del momento de la venta.
CREATE TABLE sale_items(
 branch_id uuid NOT NULL REFERENCES branches(id),
 sale_id uuid NOT NULL,
 line integer NOT NULL CHECK(line>0),
 product_id uuid NOT NULL,
 clave text NOT NULL,
 description text NOT NULL,
 -- Milésimas: 1000 es una pieza o un kilo; 750 son 750 gramos.
 quantity_milli bigint NOT NULL CHECK(quantity_milli>0),
 unit_price_cents bigint NOT NULL CHECK(unit_price_cents>0),
 total_cents bigint NOT NULL CHECK(total_cents>=0),
 PRIMARY KEY(branch_id,sale_id,line),
 FOREIGN KEY(branch_id,sale_id) REFERENCES sales(branch_id,id),
 FOREIGN KEY(branch_id,product_id) REFERENCES products(branch_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT unnest(ARRAY['products','product_catalogs','sales','sale_items']) LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY branch_isolation ON %I USING (branch_id = nullif(current_setting(''app.branch_id'',true),'''')::uuid) WITH CHECK (branch_id = nullif(current_setting(''app.branch_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shifttrack_app') THEN
  GRANT SELECT,INSERT,UPDATE ON products,product_catalogs,sales,sale_items TO shifttrack_app;
 END IF;
END $$;
