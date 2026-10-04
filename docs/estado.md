# Estado y evidencia

## Alcance implementado

| Requisitos                      | Implementación                                                                                                                  | Evidencia                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ACC-01/02, ROL-01/02/03         | Usuario/contraseña, sesión opaca propia en SQL (hash, 8 horas y revocación), revisión de cuenta actual por petición, tres roles | Integración: login, denegación por rol y sucursal; navegador: misma pantalla                                            |
| SUC-01, ACC-03                  | Sucursales, zona IANA, RLS PostgreSQL con rol sin bypass, bajas lógicas                                                         | Integración: acceso cruzado, RLS sin contexto, conservación de tickets                                                  |
| CAJ-01/02                       | Caja configurable, un equipo por sucursal; sustitución bloqueada                                                                | Navegador: Caja 2, otro empleado y pestaña excluida                                                                     |
| OPE-01/02                       | Fichaje del mismo día, cortes únicos y etiqueta original, centavos exactos                                                      | Integración: corte y repetición; dominio: 07:29/07:30/16:59/17:00                                                       |
| CIE-01/02                       | Cierre contado, relevo vinculado, reconciliación del turno anterior                                                             | Integración y navegador: contado entrante, diferencia conservada                                                        |
| COR-01                          | Pausa solicitada por administrador, ack de secuencia del equipo, rectificación/devolución separadas                             | Integración: denegación antes de pausa, no modifica original ni conteo                                                  |
| FIN-01/02/03                    | Apertura explícita, proveedores como parte del total, gastos/retiros/ajustes, ledger de efecto único                            | Integración: ejemplo $10,000/$2,000/$5,000, pago concurrente 100 veces                                                  |
| OFF-02/03/04/05                 | IndexedDB, claves cifradas, concesión por usuario/equipo, 8 horas, cola firmada, secuencia, reenvío                             | Navegador: recarga offline, dos empleados, reloj atrasado, vencimiento conservando pendientes, reconexión               |
| Tareas / evidencia              | Tareas únicas/recurrentes, catálogo, nota/foto opcional, blob local, lectura privada                                            | Integración: generación repetida, imagen real, otra sucursal denegada; navegador: foto capturada offline y sincronizada |
| Correo y procesos               | Outbox transaccional, worker idempotente, SMTP configurable, historial y revisión de entrega incierta                           | Integración con SMTP local: generación, deduplicación y reintento explícito                                             |
| Horarios / faltantes / reportes | Horarios, copia de semana, faltantes, asistencia, auditoría y XLSX                                                              | Exportación leída como Excel en integración; formularios operativos                                                     |

Ver comandos reales en `package.json`. Los resultados detallados de pruebas están en `tests/`; no se considera que una compilación por sí sola valide el negocio.

## Verificación de la migración sin Firebase

En esta tarea pasaron 19 pruebas de dominio/integración, incluida revocación por cierre de sesión, vencimiento, contraseña y baja de usuario. El mismo flujo E2E de dos empleados, pagos/foto offline y sincronización pasó tanto contra el preview como dentro de la imagen Docker de producción. Se verificó que la sesión y la fotografía permanecen tras reiniciar el contenedor, que la API ejecuta con UID/GID 1000 y que rechaza almacenamiento efímero en producción. La compilación y la auditoría de dependencias de producción pasaron. Esta evidencia es local; no confirma un despliegue Railway operativo.

## Trabajo que aún impide declarar el piloto completo

- Completar comparación pantalla por pantalla con la instalación actual y aceptación operativa por César. Se conservan los nombres y el menú, pero no se declara todavía paridad total.
- Completar la comparación de reportes, filtros y analítica con la referencia: ya hay compras netas por proveedor, tendencias diarias, promedios por empleado/caja/día, avisos provisionales y resumen de tareas. Las pruebas cubren importes de muestra; falta la aceptación de paridad completa.
- Configurar y probar el proveedor SMTP real. El worker, outbox, historial y reintento manual ya se probaron contra un servidor SMTP local. El envío permanece deshabilitado hasta configurar/verificar SMTP y habilitarlo por sucursal. Por defecto hay un intento automático; cualquier política de reintentos ampliada debe configurarse explícitamente. No se enviaron correos a destinatarios externos.
- Recuperación/sustitución de equipo con cuarentena de la época anterior y resolución administrativa de colas conflictivas. La sustitución se bloquea antes de permitir un segundo escritor; los conflictos se conservan para revisión, sin un asistente de resolución todavía.
- Probar reinicio completo del sistema operativo, falla real de disco/cuota, pérdidas parciales de red y restauración de respaldos. Se probó recarga del navegador con persistencia; no se presenta como prueba de reinicio del equipo.
- Completar el despliegue en Railway con PostgreSQL, volumen privado de fotografías, trabajador programado, secretos, respaldos y observabilidad. Verificar restauración, consumo, latencia y acceso real. Las pruebas de identidad usan las sesiones propias y PostgreSQL local; no hay emulador ni dependencia de Firebase.
- Verificar dos sucursales en operación física, capacidades offline en Chrome/Edge de las computadoras de tienda y revisión del protocolo criptográfico. Un navegador administrado por un atacante no tiene un reloj ni identidad física inviolables.
- Pruebas/infraestructura de correo y recuperación requerirán decisiones específicas y servicios externos; no se inventan credenciales ni se activan gastos.

El importador Excel de empleados/proveedores/horarios permanece fuera del alcance, conforme a los documentos. No se importaron movimientos antiguos ni se tocó la instalación anterior.

## Aclaración contable resuelta

César confirmó: «solo corresponde a ventas de ese turno». Ese es el significado del efectivo contado del corte. Implementación: sumar contado a general, tarjeta a banco y restar tickets válidos una vez. Se conserva esperado/diferencia para reportar, sin añadir la diferencia a caja general. Falta la aceptación del piloto con capturas reales, no una nueva decisión sobre esta fórmula.

## Límites locales

No habilitar operación offline en navegación privada. El permiso de almacenamiento persistente depende del navegador; IndexedDB no sobrevive a borrado de datos/perfil, pérdida o daño del dispositivo. Los pendientes no tienen eliminación automática. Los confirmados se conservan actualmente; compactación/retención pendiente. La nueva PWA deja una actualización esperando y no fuerza recarga ni borra colas.

Al recuperar Internet con una sesión local offline, se pueden subir pendientes mediante el transporte de dispositivo. Para descargar nuevos datos privados o reanudar una caja pausada por una corrección, se requiere una sesión propia validada online; el canal de pendientes no concede lectura ni renueva las ocho horas.
