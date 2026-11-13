# Estado y limitaciones

Mostrador 2.0 incluye usuarios por sucursal, cajas, cortes, proveedores, importación de proveedores desde Excel, asistencia, horarios, tareas, reportes, alertas y operación offline. Consulta las reglas en el [README](../README.md).

Las sesiones online vencen a las nueve horas. Las concesiones offline nuevas no vencen por tiempo. La exclusividad de caja solo puede comprobarse con conexión. Los pendientes y conflictos se conservan para revisión; la descarga de pendientes no incluye fotografías.

Las fotografías confirmadas se eliminan automáticamente después de 30 días. Deben verificarse los respaldos de PostgreSQL y del volumen y ensayarse su restauración antes de depender de ellos. La pérdida del dispositivo o del perfil del navegador puede hacer perder datos offline pendientes.

El worker completa las tareas por caja y turno de quien está trabajando y evalúa alertas; no envía correos. La aceptación operativa, la recuperación de dispositivos y las pruebas de restauración deben verificarse antes de dar por completo el piloto. No asumir el estado actual de producción a partir de resultados históricos de pruebas o despliegues.

Para verificar el código local, ejecutar `npm test`, `npm run build:local` y `bash scripts/ci-e2e.sh` con PostgreSQL local y las dependencias instaladas. El flujo CI está definido en `.github/workflows/checks.yml`.
