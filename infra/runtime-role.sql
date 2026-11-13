-- Ejecutar como dueño de migraciones DESPUÉS de aplicar las migraciones.
-- scripts/provision.ts crea shifttrack_app si no existe y le asigna la contraseña de
-- RUNTIME_DATABASE_URL antes de ejecutar este archivo.
ALTER ROLE shifttrack_app NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO shifttrack_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO shifttrack_app;
GRANT DELETE ON device_challenges, device_sessions, auth_sessions, register_leases, schedules, tasks TO shifttrack_app;
REVOKE ALL ON schema_migrations FROM shifttrack_app;
