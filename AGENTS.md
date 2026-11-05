# Instrucciones para trabajar en Mostrador 2.0

- Lee `README.md` y los documentos pertinentes de `docs/` antes de modificar reglas o infraestructura. Actualiza la documentación cuando cambie el comportamiento.
- Respeta el aislamiento entre sucursales y conserva el historial de usuarios, movimientos, cortes y demás registros. Verifica permisos y funcionamiento offline cuando el cambio los afecte.
- Conserva los datos y operaciones pendientes de sincronización. No uses el seed ni datos de ejemplo en producción.
- Crea una migración nueva para cambios de base de datos; no modifiques migraciones ya aplicadas. Consulta `docs/railway.md` antes de trabajar con producción y verifica el resultado.
- No expongas contraseñas, tokens, claves ni URLs con credenciales en código, documentación o registros.
- Ejecuta las pruebas adecuadas al cambio. Los comandos están en `package.json`; usa PostgreSQL local para las pruebas que lo requieran. Indica qué verificaste y cualquier limitación.
- Mantén los cambios enfocados en la solicitud y respeta el trabajo existente en el repositorio.
