# 02 — ShiftTrack 2.0: especificación maestra

> Actualización del 4 de octubre de 2026: las reglas actuales sustituyen las referencias históricas a ocho horas, reservas de dos minutos y equipo designado. Las sesiones, cajas y concesiones nuevas no vencen por tiempo. Al seleccionar caja online se prepara automáticamente un equipo de esa sucursal; proveedores depende de la caja configurada. La salida libera la caja y un administrador puede liberar una sesión abandonada con contraseña. El corte nuevo queda vinculado a la entrada real (05:00–antes de 15:00 mañana; 15:00–antes de 05:00 tarde), con fecha anterior para entradas antes de 05:00. No se solicita horario opcional. La migración 007 conserva el historial.

**Versión:** 1.0.  
**Fecha:** 3 de octubre de 2026.  
**Propietario del proyecto:** César Galaviz.  
**Destino:** nueva aplicación para Firebase/Google Cloud.  
**Estado:** requisitos funcionales acordados; diseño técnico detallado pendiente.

## 1. Propósito y autoridad del documento

Construir una nueva versión de ShiftTrack que conserve casi exactamente los módulos, pantallas y funcionamiento de la aplicación actual, preparada para operar en la nube y en varias sucursales.

La primera versión busca continuidad de la operación. Las ampliaciones y cambios de interfaz se decidirán después de comprobar su funcionamiento en Firebase.

Este documento reúne las decisiones expresadas por el propietario durante la conversación. Complementa el documento 01, «Especificación funcional de ShiftTrack actual», basado en el repositorio `cesar04610/shifttrack`, commit `2cf7a06afcce071fbdc02e7e4aeff2a738bca090`.

Cuando haya una diferencia, las decisiones de este documento prevalecen sobre el comportamiento de referencia. Los comportamientos no modificados deben conservarse, tomando como referencia la versión actual y validándolos con el propietario cuando exista ambigüedad.

No se ha construido, desplegado ni probado la nueva aplicación. Este documento permite iniciar el diseño técnico y organizar el desarrollo; no sustituye el esquema de datos, los contratos de operaciones ni las pruebas de implementación.

## 2. Alcance de la primera versión

### ALC-01 — Conservar módulos existentes

Mantener:

- Inicio y cierre de sesión; cambio de contraseña.
- Administración de usuarios normales.
- Horarios y copia de semanas.
- Fichaje de entrada/salida y horas trabajadas.
- Asistencia, ausencias, dashboard y reportes.
- Catálogo de tareas, asignaciones, recurrencias e instancias.
- Finalización de tareas, notas y fotografías.
- Proveedores y tickets de compra/pago.
- Caja de proveedores, adiciones, saldos, relevos y cierres.
- Cortes de caja, diferencias, promedios, tendencias y alertas.
- Faltantes de producto.
- Caja general, gastos, retiros bancarios, ajustes y categorías.
- Configuración de correo, destinatarios y procesos automáticos.
- Exportaciones Excel existentes.

Conservar distribución, nombres y flujos familiares de las pantallas en la medida compatible con los cambios expresamente aprobados.

### ALC-02 — Cambios aprobados

Las diferencias autorizadas para esta versión son:

1. Tres roles: superadministrador, administrador y usuario normal.
2. Separación de información y accesos por sucursal.
3. Selector de sucursal exclusivo del superadministrador.
4. Caja de proveedores configurable independientemente del número de caja.
5. Captura temporal persistente sin Internet y sincronización posterior.
6. Relevo de empleados sin Internet en el equipo de proveedores preparado.
7. Acceso sin Internet de ocho horas desde la última validación en línea de cada empleado en ese dispositivo.
8. Conteo obligatorio cuando quedó pendiente el cierre del día anterior.
9. Correcciones posteriores al cierre mediante administrador, con motivo e historial.
10. Cálculo de caja general con efectivo contado de los cortes.
11. Desactivación de empleados conservando su historial.
12. Comprobación de permisos en el servidor sin alterar innecesariamente la experiencia actual.

### ALC-03 — Fuera del alcance inicial

No añadir punto de venta por producto, inventario completo, reparto, facturación, nómina nueva ni aplicaciones móviles nativas. No importar movimientos financieros antiguos ni saldos de la instalación anterior.

El importador desde Excel se trabajará después. La creación de la aplicación y su base de datos tiene prioridad.

## 3. Inicio de sesión y roles

### ACC-01 — Pantalla común

La pantalla inicial será igual para todos y solicitará exclusivamente nombre de usuario y contraseña. No pedirá elegir rol, sucursal ni caja antes de identificar al usuario.

El sistema verificará la cuenta y dirigirá al menú correspondiente. La resolución posterior de la caja/dispositivo se diseñará sin alterar esta condición de acceso inicial.

### ROL-01 — Superadministrador

Corresponde al dueño y tiene todos los permisos del administrador. Puede crear otros superadministradores y administradores, y administrar usuarios normales. Puede acceder a todas las sucursales y seleccionar la sucursal con la que trabaja.

Puede configurar cuál caja y equipo administran proveedores por sucursal. Las futuras funciones exclusivas del dueño se incorporarán mediante nuevas decisiones.

Inicialmente comparte la estructura del menú administrativo con el administrador. El selector de sucursal y las acciones exclusivas de gestión de roles se muestran solo al superadministrador, dentro de esa estructura común.

### ROL-02 — Administrador

Conserva todos los permisos administrativos de la versión actual: usuarios normales, horarios, tareas, reportes, alertas, analítica de proveedores, cortes y tesorería, así como las modificaciones actualmente disponibles en esas pantallas.

Puede crear y administrar usuarios normales de su sucursal. Solo accede a la sucursal asignada y no tiene selector de sucursal. Cada sucursal debe contar con su administrador; no se ha establecido un límite de una única cuenta administradora por sucursal.

No puede crear superadministradores o administradores ni ascender su propia cuenta. «Acceso a todo» significa acceso administrativo completo en su sucursal según el funcionamiento actual, sin atribuirle automáticamente cada acción del menú operativo de empleados.

Puede autorizar las correcciones posteriores a un cierre contempladas en este documento.

### ROL-03 — Usuario normal

Accede únicamente a las pantallas de usuario normal y a la información de su sucursal según los permisos existentes. Mantiene consulta de horario propio, fichaje, tareas propias, faltantes, corte propio y operaciones de proveedores cuando trabaja en la caja habilitada.

No accede a pantallas administrativas, no crea cuentas y no cambia de sucursal.

### ACC-02 — Protección de operaciones

La interfaz presenta únicamente las acciones correspondientes al rol y al contexto. El servidor vuelve a comprobar identidad, rol, sucursal y autorización de caja cuando aplique. La sucursal indicada por el navegador no basta para obtener acceso.

Estos controles implementan la autorización ya acordada; no introducen nuevos pasos de aprobación para las operaciones normales.

### ACC-03 — Conservación de empleados

La acción de quitar un empleado de la operación lo desactiva. Sus fichajes, tareas, pagos, cortes y cierres permanecen consultables y atribuidos a su identidad histórica.

No borrar definitivamente al empleado cuando ello rompa relaciones o elimine su historial. La nueva aplicación no debe perder operaciones por dejar de mostrar una cuenta inactiva.

## 4. Sucursales, cajas y dispositivos

### SUC-01 — Separación por sucursal

Cada usuario administrador o normal pertenece a una sucursal. Horarios, tareas, proveedores, pagos, cajas, faltantes, cortes, saldos y reportes quedan identificados por sucursal. El superadministrador actúa sobre una sucursal seleccionada y la interfaz muestra claramente cuál es.

Los saldos y movimientos no se mezclan entre sucursales. Los horarios y fechas operativas deben calcularse de forma consistente para la sucursal, incluso si el dueño consulta desde otro lugar.

No se ha acordado todavía gestionar negocios independientes con propietarios distintos. El alcance confirmado es una aplicación con varias sucursales; no asumir un superadministrador global de negocios ajenos.

### CAJ-01 — Función de proveedores

El número de caja no determina por sí mismo su función. Una caja de cada sucursal se configura como caja de proveedores.

Ejemplos: Caja 3 en la sucursal actual; Caja 1 o Caja 2 en una sucursal que solo tiene dos cajas. La caja elegida conserva sus funciones habituales y agrega el acceso a Proveedores y Caja Proveedores.

Conservar el uso exclusivo por un responsable a la vez y la entrega de saldo al cambiar de turno, adaptando la regla actual de Caja 3 a la caja configurada.

### CAJ-02 — Equipo designado

Designar una computadora por sucursal para operar proveedores durante desconexiones. Solo ese dispositivo registra movimientos de dicha caja sin Internet. Las demás computadoras pueden conservar sus propias capturas autorizadas de tareas y cortes, pero no operar en paralelo la misma caja de proveedores desconectada.

Identificar de forma persistente el equipo y mostrar su sucursal/caja. La forma técnica de registrarlo, sustituirlo o recuperar sus pendientes se define antes de implementar.

No habilitar silenciosamente un segundo equipo sin conexión. Si se necesita sustituir el equipo, habrá que reconciliar el saldo y los registros pendientes del anterior.

## 5. Reglas operativas que se conservan

### OPE-01 — Fichaje dentro del día

Conservar la búsqueda de entrada/salida dentro del mismo día operativo. No añadir turnos que crucen medianoche: el propietario confirmó que actualmente nadie trabaja después de medianoche.

Mantener prevención de segunda entrada abierta en ese día, horario opcional, GPS opcional y cálculo de horas. No añadir fotografía obligatoria, geocerca ni bloqueo por ausencia de horario sin una aprobación posterior.

### OPE-02 — Etiqueta del corte por hora de captura

Conservar la regla que resolvió problemas previos del propietario:

- Mañana: desde las 07:30 hasta antes de las 17:00.
- Tarde: el resto de las horas.

Mantener un corte por empleado, fecha y etiqueta, fichaje previo del día, captura de ventas/tarjeta/efectivo y reporte de diferencias. No sustituir esta regla por el horario programado.

Para cortes capturados sin Internet, la etiqueta debe corresponder al momento original de captura en la sucursal, no a la hora de llegada a la nube. Verificar el tratamiento del reloj local y las capturas duplicadas durante el diseño técnico.

### OPE-03 — Tareas y proveedores

Conservar recurrencias, estados, prioridades y evidencia opcional de tareas. Mantener tickets con proveedor, importe y nota, historial de anulaciones, cálculo de saldo y avisos de compras inusuales según la referencia actual.

La ventana habitual de anulación propia sigue siendo cinco minutos antes del cierre; la regla especial posterior al cierre se define a continuación.

## 6. Cierres y correcciones de proveedores

### CIE-01 — Cierre habitual

Cada vez que termina un turno, el responsable cuenta y declara cuánto dinero quedó. Guardar saldo esperado, saldo contado, diferencia, responsable y fecha/hora.

El saldo contado es la base que recibe el siguiente responsable. Mantener ese procedimiento tanto conectado como sin Internet.

### CIE-02 — Cierre pendiente del día anterior

Si el día anterior quedó operación de proveedores sin un cierre correspondiente, pedir conteo y confirmación del efectivo antes de permitir nuevos movimientos de proveedores.

Mostrar el saldo esperado disponible y capturar el saldo real. Conservar la diferencia y el vínculo con la operación pendiente. No asumir que cerrar el navegador equivale a cerrar turno ni reemplazar movimientos por un saldo sin dejar trazabilidad.

La detección debe considerar registros pendientes guardados en el dispositivo; no evaluar únicamente el último estado recibido por la nube.

### COR-01 — Corrección después de un cierre

Un usuario normal no puede modificar por sí mismo un pago de un turno ya cerrado. Requiere intervención del administrador o superadministrador, motivo y registro del ajuste vinculado al pago y cierre originales.

Distinguir:

- Corrección de una captura errónea: rectifica su efecto según la operación real.
- Devolución física de dinero: registra un ingreso/devolución vinculado al pago original.

No borrar silenciosamente el original ni alterar el saldo que recibió otro empleado sin dejar una operación de corrección visible. Los reportes y tesorería deben reflejar una única vez el efecto financiero efectivo.

La interfaz concreta, fecha contable del ajuste y posibilidad de autorizar estas correcciones sin Internet quedan pendientes del diseño detallado. No prometer autorización administrativa sin conexión solo por haber aprobado el relevo offline de empleados.

## 7. Caja general y saldos iniciales

### FIN-01 — Efectivo contado

Para alimentar caja general, usar el efectivo declarado/contado de los cortes en lugar del efectivo esperado. Mantener el esperado para calcular sobrantes/faltantes y para los reportes actuales.

Conservar por separado los pagos con tarjeta para el saldo bancario y el funcionamiento de gastos, retiros y ajustes.

Evitar sumar dos veces una diferencia de corte: si se incorpora el contado, la diferencia ya afecta ese importe. En las pruebas debe verificarse qué incluye exactamente el efectivo contado para no restar nuevamente un pago que ya hubiera reducido la cifra capturada. Esa conciliación no autoriza cambiar el procedimiento habitual sin confirmar el caso con el propietario.

### FIN-02 — Gastos y pagos a proveedores

Conservar la captura de gastos extraordinarios del administrador tal como está. No prohibir categorías de proveedores ni introducir una nueva restricción automática de duplicados: el propietario confirmó coordinación entre cajero y administrador.

Un ticket válido de proveedores reduce automáticamente el saldo general una vez. Si se registra además como gasto manual independiente, se conserva el efecto de ambos registros según el funcionamiento actual; evitar esa duplicidad es parte de la coordinación operativa acordada.

### FIN-03 — Arranque financiero nuevo

No importar dinero, movimientos financieros, cortes o saldos anteriores. El propietario capturará y ajustará los saldos de arranque; desde ahí se generan registros nuevos.

Proporcionar una inicialización explícita por sucursal de efectivo general, banco y caja de proveedores, con responsable y fecha de arranque. La distribución exacta del efectivo entre caja general y proveedores debe quedar definida en el modelo contable para no contar dos veces el mismo dinero. Esto se resuelve dentro de la nueva aplicación, no extrayendo saldos antiguos.

## 8. Trabajo sin Internet

### OFF-01 — Operaciones disponibles

Preparar la aplicación para guardar tareas completadas, notas, fotografías, cortes, proveedores y movimientos de caja de proveedores sin Internet, cuando el usuario y dispositivo tengan autorización válida y los datos necesarios estén disponibles localmente.

No asumir que reportes completos, creación de administradores, cambio de sucursal o todas las operaciones de tesorería funcionan offline. Esas capacidades no forman parte del alcance acordado.

### OFF-02 — Almacenamiento persistente

Guardar capturas y fotografías en almacenamiento persistente del dispositivo, no únicamente en memoria. Cerrar y volver a abrir el navegador no debe perder operaciones ya confirmadas localmente.

Mostrar «Guardado en este equipo — pendiente de sincronizar», «Sincronizado» o «Requiere revisión» según corresponda. No presentar una captura local como si ya estuviera guardada en la nube.

La resistencia a reinicios debe probarse. El borrado de datos del navegador, pérdida o daño del equipo puede afectar información aún no sincronizada; no prometer protección ante esas situaciones sin un mecanismo específico.

### OFF-03 — Acceso preparado por empleado y equipo

Mientras hay Internet, preparar el acceso de empleados autorizados en la computadora designada. No almacenar contraseñas en texto visible. Una cuenta nunca preparada no puede hacer su primer acceso sin conexión.

La autorización offline es por empleado y dispositivo y expira ocho horas después de su última validación en línea. Cambiar de empleado, reiniciar el navegador o volver a introducir su contraseña localmente no reinicia ese plazo.

Al vencer, bloquear nuevas operaciones autenticadas hasta validar con conexión. Conservar todos los pendientes; su expiración no los borra. La aplicación deberá permitir enviarlos posteriormente por un procedimiento que valide su autoría y autorización en el momento de captura.

No se puede conocer una desactivación remota mientras el dispositivo no tiene conexión. El plazo de ocho horas limita ese periodo. La renovación exige validación efectiva del servidor, no simplemente detectar que existe red.

### OFF-04 — Relevo sin conexión

1. El saliente cuenta dinero y cierra turno localmente.
2. La computadora conserva saldo contado, diferencia y responsable.
3. El entrante ingresa su propio usuario y contraseña.
4. Se verifica que tenga acceso previamente preparado y aún vigente en ese equipo.
5. Recibe el saldo contado del cierre anterior y registra movimientos con su propia identidad.
6. Al reconectar se envía la secuencia completa de pagos, cierres y relevos.

No compartir una sola cuenta para resolver el cambio de empleado. Si el entrante no está preparado o su autorización venció, necesita conexión para validar; no se omite el control.

### OFF-05 — Sincronización

Asignar a cada operación un identificador estable, sucursal, dispositivo, usuario, momento original y relación con turno/caja. Reintentar un envío no puede producir una segunda operación financiera.

Conservar orden y dependencias: un ticket no debe llegar sin su proveedor o sesión; un relevo debe seguir al cierre que le entrega saldo. Adjuntar las fotografías y mantener el pendiente hasta confirmar recepción válida.

Ante duplicados, permisos cambiados o conflictos financieros, conservar el registro local y mostrar revisión pendiente. No reemplazar saldos ni descartar capturas automáticamente para resolver un conflicto.

El reloj local, la recuperación tras un envío parcialmente confirmado y la reconciliación con movimientos concurrentes de la nube requieren diseño técnico y pruebas antes de considerar completa esta función.

## 9. Importación futura desde Excel

Se pospone hasta que la aplicación y su base de datos estén listas. El alcance previsto incluye empleados, proveedores y horarios. No incluye movimientos anteriores ni dinero.

Preparar después una extracción desde una copia consistente de la base actual y una plantilla de importación con validación y previsualización de errores/duplicados por sucursal. No depender de GitHub para obtener los datos reales.

Las cuentas importadas deberán tener un procedimiento de asignación de nuevas credenciales; no intentar recuperar contraseñas originales en texto. No importar tareas por defecto, dado que no se incluyeron en la última decisión de extracción.

## 10. Diseño técnico que debe completarse

Firebase/Google Cloud es el entorno objetivo. La selección exacta de servicios y base de datos no está decidida por esta especificación; no asumir que usar Firebase implica utilizar Firestore ni que el acceso offline de usuarios viene resuelto automáticamente.

Antes de construir la infraestructura definitiva, elaborar un anexo técnico que concrete:

1. Autenticación con nombre/contraseña y preparación local de ocho horas; creación inicial del dueño y cambios de roles.
2. Base de datos, esquema, relaciones, reglas de acceso por sucursal y registro de cambios.
3. Backend, operaciones atómicas, identificadores únicos y prevención de duplicados.
4. Almacenamiento de fotografías y protección de acceso.
5. Aplicación disponible offline, almacenamiento local y límites de capacidad.
6. Registro de dispositivos, bloqueo de caja y sincronización ordenada con conflictos.
7. Fecha operativa, zona horaria y validación de tiempos de capturas offline.
8. Fórmulas de efectivo/banco, apertura de saldos y efecto de ajustes/devoluciones.
9. Procesos automáticos, correos, destinatarios, historial de entrega y política de reintentos.
10. Respaldos, recuperación, despliegue, entornos de prueba y costos estimados.

Estas son decisiones de implementación que el asistente debe proponer y verificar, explicándolas en términos simples. No trasladar al propietario elecciones técnicas sin presentar una alternativa concreta y sus consecuencias.

Las alertas deben conservar su finalidad actual. La corrección de reintentos de correo se identificó en el análisis, pero no recibió una decisión específica; documentar la propuesta antes de cambiar su comportamiento.

## 11. Criterios de aceptación

La versión inicial estará lista para una prueba operativa cuando se demuestre:

- Una misma pantalla dirige correctamente a los tres roles.
- Administrador y usuario normal no leen ni modifican otras sucursales, incluso mediante solicitudes directas.
- Solo superadministrador selecciona sucursal y crea cuentas administrativas.
- Los módulos actuales mantienen su comportamiento, salvo las diferencias enumeradas en ALC-02.
- Caja 1 o 2 puede actuar como caja de proveedores en una sucursal sin Caja 3.
- No se permite registrar movimientos nuevos de proveedores hasta reconciliar un cierre pendiente del día anterior.
- El responsable entrante recibe el saldo contado del saliente.
- Una corrección posterior al cierre deja original, motivo, autor y efecto financiero trazables.
- Caja general utiliza el efectivo contado y mantiene el funcionamiento de gastos extraordinarios.
- Un empleado desactivado conserva su historial consultable.
- Las capturas offline sobreviven a cerrar/reabrir la aplicación y a un reinicio ordinario del equipo.
- Dos empleados preparados pueden relevarse sin Internet en el equipo autorizado.
- Las ocho horas se cuentan desde la validación en línea de cada empleado en ese equipo; no se renuevan localmente.
- Un acceso vencido bloquea nuevas capturas, conservando los pendientes.
- Reconexiones y reintentos no duplican tickets, cortes, cierres, proveedores ni efecto en saldos.
- La etiqueta del corte corresponde a su hora original de captura y conserva el límite de las 17:00.
- El negocio arranca con saldos capturados manualmente y sin movimientos históricos importados.
- Reportes y exportaciones coinciden con la información financiera y de personal validada.

Estos son criterios para pruebas futuras, no resultados ya obtenidos.

## 12. Secuencia de construcción

1. Diseñar arquitectura, modelo de datos, autenticación y sincronización; validar con un prototipo el acceso offline de ocho horas.
2. Crear sucursales, cajas, dispositivos y los tres roles.
3. Reconstruir empleados, horarios, fichaje y asistencia.
4. Reconstruir tareas, fotografías y sus reportes.
5. Reconstruir proveedores, caja configurable, pagos, cierres y correcciones.
6. Reconstruir cortes, faltantes, tesorería y apertura de saldos.
7. Completar procesos automáticos, alertas, reportes y Excel.
8. Verificar offline y sincronización en cada módulo, incluyendo fallos y reintentos.
9. Realizar prueba de una sucursal con datos nuevos y luego validar aislamiento entre sucursales.
10. Preparar importación de empleados/proveedores/horarios posteriormente, cuando se solicite.

Conservar la aplicación actual funcionando durante el desarrollo. Este documento autoriza preparar el diseño y sirve como guía de construcción; no implica por sí mismo cambiar la instalación operativa ni activar servicios de pago.

## 13. Instrucción para el agente que construya la aplicación

Implementa ShiftTrack 2.0 conforme a esta especificación y al inventario funcional de la versión actual. Conserva módulos y experiencia del usuario, aplicando únicamente los cambios expresamente acordados. Distingue hechos de la referencia, requisitos nuevos y propuestas técnicas. Completa el anexo técnico antes de tomar decisiones de infraestructura irreversibles. No inventes permisos, no mezcles sucursales y no sustituyas la política de ocho horas por una sesión local que se renueva sola. Cada módulo debe demostrar sus criterios de aceptación con datos de prueba. Mantén trazabilidad entre requisitos, implementación y pruebas.
