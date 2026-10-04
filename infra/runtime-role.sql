-- Ejecutar como dueño de migraciones DESPUÉS de aplicar las migraciones.
-- Crear previamente shifttrack_app con contraseña segura / autenticación IAM.
ALTER ROLE shifttrack_app NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO shifttrack_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO shifttrack_app;
GRANT DELETE ON device_challenges, device_sessions TO shifttrack_app;
REVOKE ALL ON schema_migrations FROM shifttrack_app;
