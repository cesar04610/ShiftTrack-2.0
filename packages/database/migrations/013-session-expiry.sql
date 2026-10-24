-- Sesiones abiertas antes de esta versión terminan 9 horas después del despliegue.
UPDATE auth_sessions SET expires_at=now()+interval '9 hours' WHERE expires_at IS NULL;
