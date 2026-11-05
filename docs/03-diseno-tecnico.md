# Diseño técnico

Mostrador 2.0 es una PWA React/TypeScript con API Node.js/Express y PostgreSQL en Railway. La API y el frontend comparten imagen; las fotografías se almacenan en un volumen privado. El worker separado genera tareas recurrentes y evalúa alertas.

La API autentica con sesiones propias y contraseñas Argon2. PostgreSQL aplica aislamiento por sucursal y el rol `shifttrack_app` opera sin propiedad de tablas ni bypass de RLS. Las sesiones online vencen a las nueve horas.

IndexedDB conserva datos y operaciones offline, incluidas fotografías pendientes. Las operaciones se firman por usuario y equipo y se sincronizan al recuperar conexión. Los conflictos y pendientes se conservan para revisión. La descarga de pendientes no incluye fotografías ni claves privadas.

Las fotografías confirmadas se eliminan automáticamente después de 30 días. El volumen persistente no sustituye un respaldo. Consultar [Railway](railway.md) para configuración y migraciones y [estado](estado.md) para limitaciones.
