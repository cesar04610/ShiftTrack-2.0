-- Notificaciones leídas: la fecha en que el súper administrador marcó el aviso. Los avisos anteriores
-- quedan sin leer; se conservan todos.
ALTER TABLE alert_log ADD COLUMN read_at timestamptz;
