# Reglas funcionales

La aplicación gestiona sucursales, empleados, cajas, asistencia, cortes, proveedores, tareas, horarios, reportes y alertas. Las reglas operativas actuales están en el [README](../README.md); el despliegue se describe en [Railway](railway.md).

Cada sucursal configura sus cajas y la caja de proveedores. Una caja no puede estar ocupada por dos sesiones online. Administradores y superadministradores pueden entrar sin caja; los pagos de proveedores requieren seleccionar la caja configurada. La baja de sucursal y de empleado conserva el historial.

El inicio de sesión online registra asistencia para empleados y administradores con sucursal. La sesión online vence a las nueve horas. La autorización offline nueva se prepara por empleado y equipo y no vence por tiempo. Sin conexión no puede comprobarse la ocupación de caja; los pendientes se sincronizan cuando se recupera la conexión.

La entrada determina el turno del corte: mañana de 05:00 a antes de 15:00; tarde de 15:00 a antes de 05:00 del día siguiente. Las entradas anteriores a las 05:00 corresponden a la tarde del día anterior.

Las fotografías de evidencia se eliminan automáticamente tras 30 días. La importación de proveedores desde Excel está disponible en Caja proveedores.

Ventas es un punto de venta de respaldo para cuando SICAR falla. El administrador importa en Productos el catálogo que exporta SICAR (`.xls`); de él solo se toman clave, clave alterna, descripción, precio 1 con impuestos y granel. El cajero vende escaneando o buscando, con las teclas de SICAR, y cobra en efectivo o tarjeta. Un producto ausente del catálogo o sin precio no se vende. Las ventas funcionan sin conexión y son informativas: el corte se sigue capturando en Mi corte con las cantidades reales, y solo el corte mueve Caja general.

Métricas compara ventas (de los cortes) y compras a proveedores (con la misma definición neta de Reportes), y por proveedor el gasto, su frecuencia, el ticket promedio y quién dejó de venir, y por empleado la puntualidad, las horas, las tareas cumplidas, la precisión de cortes y la venta por hora contra su mismo turno, y el resultado de caja (ventas menos compras y gastos extraordinarios de Caja general), y los faltantes y sobrantes de cortes y cierres de proveedores por persona, caja y turno, y, solo para el superadministrador, la comparación de todas las sucursales activas y la tendencia de alertas, contra el periodo anterior de igual duración. Es solo consulta, para administradores y con conexión.
