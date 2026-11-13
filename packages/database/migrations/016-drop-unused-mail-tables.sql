-- Tablas del aviso por correo retirado (002 y 004): ya no las usa ningún código.
-- Se borran solo si están vacías; si alguna conserva datos, se deja intacta y se avisa.
DO $$ DECLARE t text; n bigint; BEGIN
 FOREACH t IN ARRAY ARRAY['notification_outbox','alerts','alert_settings'] LOOP
  IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
  -- FORCE ROW LEVEL SECURITY también aplica al dueño de la tabla: sin sucursal en contexto
  -- contaría 0 filas aunque hubiera datos. Se quita antes de contar.
  EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
  IF n = 0 THEN
   EXECUTE format('DROP TABLE %I', t);
  ELSE
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
   RAISE NOTICE 'Se conserva % porque tiene % fila(s).', t, n;
  END IF;
 END LOOP;
END $$;
