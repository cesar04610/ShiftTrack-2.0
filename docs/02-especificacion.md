# Reglas funcionales

La aplicación gestiona sucursales, empleados, cajas, asistencia, cortes, proveedores, tareas, horarios, reportes y alertas. Las reglas operativas actuales están en el [README](../README.md); el despliegue se describe en [Railway](railway.md).

Cada sucursal configura sus cajas y la caja de proveedores. Una caja no puede estar ocupada por dos sesiones online. Administradores y superadministradores pueden entrar sin caja; los pagos de proveedores requieren seleccionar la caja configurada. La baja de sucursal y de empleado conserva el historial.

El inicio de sesión online registra asistencia para empleados y administradores con sucursal. La sesión online vence a las nueve horas. La autorización offline nueva se prepara por empleado y equipo y no vence por tiempo. Sin conexión no puede comprobarse la ocupación de caja; los pendientes se sincronizan cuando se recupera la conexión.

La entrada determina el turno del corte: mañana de 05:00 a antes de 15:00; tarde de 15:00 a antes de 05:00 del día siguiente. Las entradas anteriores a las 05:00 corresponden a la tarde del día anterior.

Las fotografías de evidencia se eliminan automáticamente tras 30 días. La importación de proveedores desde Excel está disponible en Caja proveedores.
