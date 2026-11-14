# Mostrador 2.0

Aplicación web y API en Railway con PostgreSQL, sesiones propias y fotografías privadas en un volumen persistente. Implementación inicial basada en los documentos de `docs/`, con referencia funcional a `cesar04610/shifttrack` en `2cf7a06afcce071fbdc02e7e4aeff2a738bca090`.

Esta versión permite desarrollar y probar los módulos principales y el flujo de caja offline. Todavía no es una versión certificada para operar dinero real: faltan la validación operativa del propietario, recuperación de dispositivos y configuración/verificación cloud. El estado detallado está en [docs/estado.md](docs/estado.md).

## Desarrollo

Requiere Node 24 (`package.json` admite de la 22 a la 24), npm y Docker. Usa el checkout existente: cada tarea cloud ya tiene aislamiento; no hace falta otro worktree.

```bash
npm ci
cp .env.example .env # Solo si no existe; nunca sobrescribir la configuración propia.
docker compose up -d
npm run db:migrate
npm run db:seed
```

En terminales separadas:

```bash
npm run dev
```

La API usa el puerto 8080 y Vite el 5173. Hay dos formas de levantar PostgreSQL local, cada una con su propio volumen de datos: `docker compose up -d` (volumen `shifttrack-db`) o `bash scripts/cloud-install.sh` (contenedor `shifttrack-postgres`, volumen `shifttrack-dev-db`). Usa siempre la misma; si el contenedor `shifttrack-postgres` ya existe, inícialo con `docker start shifttrack-postgres` en lugar de levantar otro PostgreSQL en ese puerto. Para comprobar la PWA offline, usa la compilación real:

```bash
npm run build:local
npx vite preview --config apps/web/vite.config.ts --port 5174
```

Vite en desarrollo no comprueba la apertura offline; las pruebas de navegador usan la compilación con service worker. Los procesos deben volver a iniciarse después de restaurar el entorno. La base local de Docker se conserva mientras exista su volumen; no es un respaldo de producción.

La API y las pruebas suponen un reloj del sistema en UTC o al oeste de UTC (como México); en una computadora con zona adelantada (Europa, Asia) ejecútalas con `TZ=UTC`, o las fechas de turnos y alertas se recorren un día. La imagen de producción ya fija `TZ=UTC`.

`.npmrc` coloca la caché de npm en `/tmp`. No se necesita Firebase, Java ni un emulador de autenticación.

## Cuentas de ejemplo

Exclusivamente con la base local de desarrollo: `cesar` (dueño), `admin` (administrador), `ana` y `luis` (empleados). Contraseña pública de estos datos de prueba: `ShiftTrack-demo-2026!`. El seed no se ejecuta en producción ni sobrescribe cuentas existentes. No hay contraseña predeterminada para producción.

1. Ingresa como `cesar`, selecciona Sucursal Centro y configura sus cajas. La caja de proveedores no depende de ser Caja 3.
2. En Caja general registra efectivo total, la parte incluida en proveedores y saldo bancario. La parte de proveedores no se suma otra vez al total.
3. Cada empleado inicia sesión con conexión y selecciona su caja. El equipo y su acceso offline se preparan automáticamente, sin vencimiento por horas.
4. El empleado abre su turno de proveedores. Registra pagos/adiciones, cuenta y cierra. Sale de su sesión; el entrante ingresa con sus credenciales y abre un turno vinculado al último cierre.
5. Sin Internet las capturas quedan guardadas en el equipo. Al reconectar se envían comandos firmados con identificadores estables, incluyendo los de empleados anteriores. No hace falta renovar su concesión para enviar capturas válidas anteriores.

Cerrar sesión no cierra automáticamente la caja ni borra pendientes. Cierra el turno explícitamente antes del relevo. Si quedó un turno de otro día, se exige conteo de reconciliación antes de nuevos movimientos.

## Inicio de administración

En **Inicio**, al tocar un empleado activo se ven sus tareas del día y cuáles realizó. El recuadro **Tareas pendientes** despliega todas las tareas del día con la persona asignada y su estado. El recuadro **Caja proveedores** abre **Actividad caja proveedores**: saldo inicial del día, cada turno con sus gastos, efectivo agregado y correcciones, y en cada cierre lo esperado, lo contado, la diferencia y con cuánto terminó. El recuadro **Efectivo general** abre **Caja general**, la misma página del menú lateral. El recuadro **Saldo bancario** abre **Movimientos bancarios**: entradas y salidas del banco con su saldo corrido. Sin rango seleccionado muestra los últimos 30 días; arriba se puede elegir Desde y Hasta, y el botón "Últimos 30 días" restablece la vista. Los filtros Todos, Depósitos (montos positivos) y Retiros (montos negativos) limitan la lista; los montos negativos se muestran en rojo. Los días se cuentan en la zona horaria de la sucursal. Esta página consulta al servidor el rango elegido, con el saldo corrido calculado sobre toda la historia, por lo que requiere conexión. El snapshot de administradores incluye las adiciones de efectivo de los últimos 3 días para este detalle.

## Tareas por día, caja y turno (noviembre 2026)

Las tareas ya no se asignan persona por persona. En **Gestionar tareas › Tareas por caja y turno** se elige el día de la semana y la caja; cada combinación tiene cuatro listas: Turno mañana, Medio turno mañana, Turno tarde y Medio turno tarde (por ejemplo, lunes › turno mañana › caja 1, o miércoles › medio turno tarde › caja 3). El administrador escribe cada lista una sola vez y se repite todas las semanas. Después puede agregar tareas, cambiarles el nombre, quitarlas o copiar la lista de otro día, caja o turno. Al editar una tarea se marcan los días en que se hace, así una misma tarea puede estar en varios días sin escribirla de nuevo; quitarla en un día la conserva en los demás, y agregar o copiar una tarea que la lista ya tiene en otro día solo le suma el día.

Quien entra a una caja recibe en ese momento las tareas de ese día de la semana, de esa caja y de su turno, sin que nadie las asigne. El día es el día de trabajo (de 05:00 a 05:00). El turno sale de su horario del día en la pizarra: cuenta desde dos horas antes de la entrada, y un horario de hasta 4 horas es medio turno. Sin horario ese día, se usa la hora de su entrada (Mañana antes de las 15:00, Tarde después) y se toma como turno completo. Una lista vacía para ese día, caja y turno no genera tareas. Las cuentas administrativas solo reciben tareas cuando eligen una caja.

- Si la persona cambia de caja o se corrige su horario en el mismo turno, sus tareas pendientes de la lista anterior se sustituyen por las de la nueva; las realizadas y las que tienen fotografía se conservan.
- En un doble turno, las tareas de la tarde llegan solas al empezar ese turno (el worker las completa cada 5 minutos para quien sigue en su caja con la entrada abierta).
- Cambiar una lista se refleja de inmediato en quien está trabajando: una tarea nueva le aparece, un nombre corregido se actualiza y una tarea quitada desaparece si seguía pendiente. Los días anteriores no cambian.
- Las tareas se generan al entrar a la caja con conexión. Quien inicia sesión sin Internet ve las que ya tenía guardadas en el equipo; las nuevas llegan al reconectar.

**Tarea extra** asigna una tarea ocasional a una persona para hoy o un día próximo, aparte de las listas; mientras esté pendiente se puede quitar. **Seguimiento** muestra, día por día (últimos 15 días), las tareas de cada persona, de qué caja y turno salieron, su estado, la nota y la fotografía, y permite reabrir una tarea realizada hoy. Estos cambios requieren conexión y quedan en Auditoría.

El catálogo de plantillas y las asignaciones recurrentes por persona se retiraron: sus tablas (`task_catalog`, `task_assignments`) se conservan con su historial, pero ya no generan tareas.

## Ventas de respaldo (cuando SICAR falla)

**Ventas** permite cobrar productos desde Mostrador cuando SICAR no está disponible. Aparece en el menú de operación de quien tiene una caja seleccionada y se maneja con las mismas teclas que SICAR:

| Tecla                                | Acción                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Escanear o escribir la clave + Enter | Agrega el producto. Si ya estaba en la venta, suma una pieza; un producto a granel entra con 1 (un kilo). El total se acumula abajo a la derecha.                                    |
| F2                                   | Busca en el catálogo por descripción o clave. Flechas para elegir, Enter para agregar.                                                                                               |
| F5                                   | Cambia la cantidad del producto seleccionado o, si no hay ninguno, del último: gramos si es a granel, piezas si no. También se abre tocando la cantidad, a la izquierda del renglón. |
| F6                                   | Elimina el producto seleccionado (se selecciona con un clic o con las flechas). Sin producto seleccionado, pregunta si se borran todos.                                              |
| Esc                                  | Abre el cobro: efectivo por defecto (F8) o tarjeta (F9), cantidad con la que paga el cliente y cambio. Enter termina la venta; dejar la cantidad vacía es pago exacto.               |
| Esc (después de cobrar)              | Cierra la pantalla informativa con el cambio entregado. Solo se cierra con Esc, para que un escaneo accidental no la quite.                                                          |
| F10                                  | Ventas del turno: ventas totales, efectivo que debe haber y pagos con tarjeta.                                                                                                       |

Un código que no está en el catálogo, o un producto sin precio, no se puede vender: la pantalla lo avisa y la venta sigue. Dentro de Ventas, F5 no recarga la página (en el resto de la aplicación recargar cierra la sesión). Una venta admite hasta 150 renglones.

**Catálogo.** En **Productos** (menú de administración) el administrador usa **Importar catálogo de SICAR** con el archivo `.xls` que SICAR exporta de sus artículos, sin modificarlo (hasta 8 MB y 20,000 productos). Solo se guardan clave, clave alterna, descripción, precio 1 y si se vende a granel; costos, existencias y demás columnas se descartan. El precio 1 de SICAR viene sin impuestos: se le suma IEPS (8%) cuando «IMP IEPS» dice S e IVA (16%) cuando «IMPUESTO» dice S, y se redondea a centavos. La vista previa muestra, antes de guardar, cuántos productos son nuevos, cambian o dejan de venderse, cuáles no tienen precio, las filas con error (se omiten) y los precios con centavos poco comunes, que suelen indicar un impuesto sin marcar en SICAR. Cada archivo reemplaza al catálogo de esa sucursal: lo que ya no viene deja de venderse, pero se conserva para las ventas que lo citan. Cada sucursal tiene su propio catálogo. Importar requiere conexión.

**Sin Internet.** Cada equipo descarga el catálogo completo al actualizar su pantalla con conexión y lo vuelve a descargar solo cuando una importación lo cambia. Las ventas se guardan primero en el equipo, firmadas como las demás capturas, y se envían al reconectar; el servidor conserva el precio con el que se cobró, aunque el catálogo haya cambiado después. Para vender sin conexión, el cajero debe haber iniciado sesión y elegido su caja con conexión al menos una vez en ese equipo.

**Corte.** Las ventas de Mostrador son informativas: no mueven Caja general ni generan el corte. **Ventas del turno** (F10) y la ficha «Ventas registradas en Mostrador» de **Mi corte** suman lo vendido por esa persona desde su último corte (máximo 24 horas): ventas totales, efectivo y tarjeta. El cajero cuenta su dinero y captura las cantidades reales en **Mi corte**, como siempre. En **Productos**, el administrador consulta las ventas de cada día de trabajo por cajero, con el detalle de cada ticket.

No incluye inventario, tickets impresos, precios de mayoreo, pagos mixtos ni cancelación de ventas ya cobradas; una venta cobrada por error se aclara en la nota del corte.

## Reportes

**Reportes** abre con una portada breve de la sucursal y el periodo elegidos (Hoy, Ayer, 7 días, Este mes, Mes pasado u otro rango de hasta 400 días). Arriba, **Requiere tu atención** lista solo lo que no cuadró o quedó pendiente: cortes y turnos de caja de proveedores con diferencia, turnos sin corte, faltas, retardos y salidas anticipadas, tareas no realizadas, faltantes sin resolver y tickets anulados; cada renglón lleva directo a esos registros. Si no hay nada, lo dice en una línea. Debajo hay una ficha por tema con su cifra principal; el detalle se ve al entrar:

- **Ventas y cortes:** ventas, tarjeta, efectivo y diferencia; cada corte con su responsable, caja y nota, y las ventas por día.
- **Gastos a proveedores:** gasto neto por proveedor y por día, tickets (con filtro de anulados) y correcciones.
- **Caja de proveedores:** apertura, esperado, contado y diferencia de cada turno.
- **Caja general:** movimientos de efectivo y banco, y cuánto cambió cada uno en el periodo (no su saldo).
- **Personal:** horas, faltas, retardos y tareas por persona; al tocar un nombre se ve su asistencia. Las faltas e incidencias se pueden filtrar por persona.
- **Tareas** y **Faltantes:** por estado, con nota y fotografía.
- **Auditoría:** cada operación con quién y cuándo; al tocarla se despliega su detalle. Se filtra por acción y usuario.

Las listas muestran primero 15 registros, con buscador y **Ver más**. **Descargar Excel** entrega todo el periodo, una hoja por tema. Reportes requiere conexión y permiso de administrador.

## Sucursales y cajas

El dueño configura la cantidad de cajas y elige la caja de proveedores entre 1 y ese total. Cada empleado selecciona su caja al entrar. Con conexión, la reserva es exclusiva por sucursal y se comprueba cada 30 segundos, sin vencimiento automático. Cerrar sesión o cerrar la ventana la libera cuando el aviso llega al servidor. Si el navegador se cierra sin red o de forma abrupta, el mismo usuario puede recuperar su caja al volver a entrar desde ese equipo. Otra pestaña abierta no puede apropiarse de la caja. Si alguien dejó una sesión abierta, el administrador puede liberar la caja desde Configuración confirmando su contraseña. El menú de proveedores depende de seleccionar la caja de proveedores configurada.

En **Caja proveedores**, los administradores y el dueño pueden usar **Importar proveedores desde Excel**. Descarga la plantilla, completa Empresa, Representante, Teléfono y Tipo de producto, carga el `.xlsx` y revisa la vista previa antes de confirmar. Solo Empresa es obligatoria. Admite hasta 2,000 proveedores y 2 MB, requiere conexión y omite empresas repetidas en la sucursal o el archivo sin modificar registros existentes. Las filas con errores deben corregirse antes de guardar; repetir la misma confirmación no duplica el resultado. También reconoce la hoja `suppliers` y los encabezados de la exportación antigua (`company_name`, `rep_name`, `rep_phone`, `product_type`).

El acceso offline se prepara automáticamente para la caja seleccionada y no vence por tiempo. Sin conexión se permite la última caja preparada y se advierte que su ocupación no puede comprobarse. Tras un login offline, al reconectar se pueden enviar los pendientes; antes de nuevas capturas online se requiere volver a iniciar sesión para reservar la caja. Los cortes quedan vinculados a la caja firmada en la concesión.

Eliminar una sucursal exige superadministrador y su contraseña actual. Se desactiva, revoca sesiones y equipos, detiene sus procesos y conserva usuarios y movimientos. Las fotografías están sujetas a la retención de 30 días. Un turno de proveedores abierto debe cerrarse primero. El dueño puede consultar el historial desde Configuración. Las capturas previas que lleguen después quedan para revisión.

## Empleados por sucursal

El nombre de usuario es único dentro de cada sucursal. El mismo empleado puede tener una cuenta en Quates y otra en Madeira, con registros y permisos separados. Si sus credenciales coinciden en varias tiendas, el inicio de sesión pide elegir la sucursal. El acceso offline preparado se conserva por usuario y tienda.

La pantalla **Usuarios** muestra una ficha por persona, ordenadas por actividad: primero quienes están en turno y después quienes trabajaron más recientemente; quienes no tienen sesiones van al final. El botón **+** abre la pantalla **Nuevo usuario**. Al tocar una ficha se ve su sesión más actual (o la última que tuvo): entrada, salida, duración, caja, horario, tareas del día y la actividad cronológica (tareas realizadas, pagos, cortes, faltantes, turno de proveedores y cambios de caja). Las flechas recorren sus sesiones anteriores. La información sale del historial de los últimos 15 días que ya está en el equipo, por lo que también funciona sin conexión; lo anterior está en Reportes › Auditoría.

En Usuarios, **Eliminar empleado** pide confirmación, retira la cuenta de la lista, revoca sus sesiones y permite reutilizar su nombre en esa sucursal. Se conserva la fila original con `deleted_at` para mantener sus registros y autoría en informes; las fotografías están sujetas a la retención de 30 días. Su cuenta en otras sucursales no cambia. **Desactivar** conserva la cuenta en la lista como inactiva. Un turno de proveedores abierto debe cerrarse antes de eliminar a su responsable.

## Pruebas

Con PostgreSQL en ejecución:

```bash
npm test
npm run build:local
# API y preview PWA en ejecución, puerto 5174:
npm run test:e2e
npm run worker:tick
npm audit --omit=dev
```

Las pruebas de integración crean sucursales y registros exclusivos de prueba. No se ejecutan contra producción. Playwright utiliza Chromium del sistema cuando está disponible; de otro modo instala el navegador con `npx playwright install chromium`. Puede configurarse `CHROMIUM_PATH` y `E2E_BASE_URL`.

## Dinero y sincronización

Importes MXN en centavos enteros, enviados como cadenas. Fecha operativa calculada en la zona IANA de la sucursal. La etiqueta y fecha del corte se calculan desde el registro de entrada: Mañana desde 05:00 hasta antes de 15:00; Tarde desde 15:00 hasta antes de 05:00 del día siguiente. Una entrada antes de 05:00 pertenece a la tarde del día anterior. El cierre no cambia el turno. Solo un corte por registro de entrada. El horario, si existe, se vincula automáticamente.

**Dos criterios de «día» (limitación conocida):** cortes, tareas y asistencia usan el día de trabajo, que termina a las 05:00. Los turnos de la caja de proveedores, y la regla que exige reconciliar un turno «del día anterior», usan el día calendario (medianoche). Un turno de proveedores que cruza la medianoche se trata como pendiente del día anterior: la persona debe hacer el conteo de reconciliación en lugar del cierre normal y no puede registrar pagos antes. Con los horarios actuales (hasta 21:30) casi no ocurre y no afecta saldos ni historial. Además, al guardar un corte el horario se busca por la fecha calendario de la entrada; si fue antes de las 05:00, el corte no se vincula a su horario. Unificar los criterios exige cambiar a la vez el servidor y la captura sin conexión, por lo que se pospone.

**Asistencia automática (octubre 2026):** iniciar sesión registra la entrada de empleados y administradores con sucursal; cerrar sesión (o cerrar la ventana) registra la salida cuando no queda otra sesión abierta del mismo usuario. Las sesiones vencen a las 9 horas y esa salida se registra a las 9 horas exactas (la API revisa cada 5 minutos). Un inicio de sesión dentro de los 15 minutos posteriores a una salida continúa el mismo registro (por ejemplo, tras recargar), salvo que ese registro ya tenga su corte: entonces se abre un registro nuevo, como en un doble turno (mañana y tarde), para que el segundo turno tenga su propio corte. El dueño no tiene sucursal al iniciar sesión, por lo que no se registra su asistencia. Sin conexión no se registra la entrada hasta volver a iniciar sesión con conexión.

**Aclaración del propietario en esta conversación:** el efectivo contado corresponde únicamente a ventas de ese turno. General recibe ese contado, banco recibe tarjeta, y cada ticket de proveedores descuenta su importe separadamente. La diferencia de corte no se suma otra vez.

**Historia reciente en pantalla:** cada actualización de pantalla (cada 30 segundos) y la copia guardada en el equipo para trabajar sin conexión solo incluyen los últimos 15 días de historia: cortes, asistencia, tareas, horarios (más los futuros), tickets y cierres de proveedores, movimientos de Caja general, auditoría y faltantes resueltos. Siempre viajan, sin importar su antigüedad, los faltantes pendientes, el turno de proveedores abierto y el último cierre con sus tickets. El saldo de Caja general lo calcula el servidor con todos los movimientos. Lo anterior se consulta en Reportes: cortes en Ventas y cortes, movimientos en Caja general (los bancarios, de cualquier fecha, también en Movimientos bancarios), cierres de proveedores en Caja de proveedores, tickets en Gastos a proveedores y asistencia en Personal. Una corrección de proveedores solo puede elegir tickets de los últimos 15 días. El plazo está en `SNAPSHOT_DAYS` (`apps/api/src/server.ts`).

Cada comando y su proyección se guardan juntos en IndexedDB. Contraseña local: PBKDF2 y AES-GCM para proteger la clave de firma del empleado; no se guarda la contraseña. La concesión se firma con ECDSA P-256 en el servidor. El transporte de dispositivo solo permite subir/confirmar pendientes; no reemplaza la identidad del empleado ni habilita consultas administrativas.

Un conflicto conserva el comando y bloquea la continuación dependiente; nunca se aplica un saldo arbitrario. Mientras ese equipo tenga una captura de proveedores rechazada, no permite nuevos movimientos de esa caja. En el recuadro «Hay operaciones que requieren revisión», un administrador con sesión y conexión en ese equipo puede **Descartar** cada captura rechazada: pide confirmación, descarga un respaldo de la captura, guarda una copia en el navegador y vuelve a cargar el estado real del servidor; si el movimiento sí ocurrió, se captura de nuevo (para un cierre, con el conteo de reconciliación). Las capturas en «Dependencia pendiente» se reintentan solas en cada sincronización. La descarga de pendientes contiene comandos y firmas, no claves privadas ni contraseñas. Fotografías pendientes se conservan en IndexedDB y no están incluidas en ese archivo de respaldo. El almacenamiento borrado o el equipo perdido requieren recuperación administrativa: ver límites en `docs/estado.md`.

## Railway

Despliegue y límites en [docs/railway.md](docs/railway.md). La imagen sirve la interfaz y la API juntas; usa PostgreSQL para identidad y datos, y un volumen privado para fotografías. No requiere Firebase ni claves de Google. Consulta las reglas y la arquitectura en los documentos de `docs/`.

El login emite un token aleatorio de 256 bits, con vencimiento fijo de 9 horas (la API lo aplica y la pantalla cierra la sesión al cumplirse), guardado por pestaña en `sessionStorage`; SQL solo conserva su hash. **Recargar la página (F5) también cierra la sesión:** el navegador avisa lo mismo al recargar que al cerrar la pestaña, y la aplicación no puede distinguirlos, así que borra el token y avisa al servidor. Hay que iniciar sesión de nuevo; la caja se libera y se recupera desde el mismo equipo, la asistencia continúa si el reingreso ocurre dentro de 15 minutos y los pendientes sin conexión se conservan. Cada petición revisa vencimiento, versión de credenciales y estado de la cuenta. El cierre online revoca esa sesión; cambiar contraseña revoca todas. El cierre sin Internet borra el acceso local, pero no puede contactar al servidor para revocar: el administrador puede liberar la caja pendiente desde Configuración. Las contraseñas usan Argon2. Solo servir la aplicación publicada con HTTPS.

La migración 005 agrega sesiones sin cambiar usuarios ni datos financieros. No se borran IndexedDB, concesiones ni pendientes. Después de cambiar contraseña o desactivar cuenta, las capturas antiguas permanecen para revisión y no se aceptan automáticamente. Una captura que el servidor ya había confirmado y se reenvía idéntica desde el mismo equipo (por ejemplo, porque se perdió la respuesta) devuelve su confirmación original en lugar de pasar a revisión. Las rutas de fotos siempre comprueban usuario, tarea y sucursal.

Las fotografías de evidencia se eliminan automáticamente después de 30 días desde su creación; sus registros se marcan como eliminados. Las fotografías pendientes en el dispositivo no forman parte de la descarga de pendientes.

En producción se exige un volumen montado real; no se admiten fotografías en el disco efímero del contenedor. La imagen prepara la carpeta del volumen y luego ejecuta la API como usuario `node`. Configurar una sola réplica para ese volumen. Los respaldos del volumen y de SQL deben verificarse antes de operar dinero real.

Las alertas de la tienda se consultan en la aplicación; el worker actual no envía correos. El inventario de API y el contrato de comandos están en `docs/openapi.json`; se regeneran con `npm run contracts`.

Mostrador 2.0 ofrece la operación diaria a empleados, administradores y súper administradores. Las cuentas administrativas pueden continuar sin caja o seleccionar una para registrar cortes y ventas; los pagos requieren la caja de proveedores. El menú de gestión conserva Usuarios, Horarios, Gestionar tareas, Reportes, Productos, Cortes, Caja general y Configuración; Alertas está reservado al súper administrador.

En Horarios, la pizarra semanal permite arrastrar fichas del personal activo, incluidos administradores y súper administradores, o seleccionar una persona y pulsar + en el turno. Mañana: 07:30–15:00 (medio turno 12:00–15:00). Tarde: 15:00–21:30 (medio turno 18:30–21:30). Seleccionar una ficha asignada permite cambiar entre turno completo y medio turno; arrastrarla a otra casilla mueve el horario. Requiere conexión y rechaza horarios superpuestos sin duplicar fichas. **Copiar horarios** de una semana a otra no aplica esa regla: solo omite el turno idéntico (misma persona, día y hora de entrada). Si la semana destino ya tiene turnos, revisa la pizarra después de copiar y quita las fichas que se crucen. Los horarios anteriores y la captura manual se conservan.

La pizarra se adapta al tamaño de la pantalla con fichas compactas, nombres cortos y un color estable por persona. Ampliar pizarra aprovecha toda la ventana; puedes volver con Reducir pizarra o Escape. El nombre completo se conserva en las opciones del turno y en la descripción de cada ficha.

## Alertas de la tienda (octubre 2026)

La pantalla Alertas del superadministrador reemplaza la configuración de avisos y el correo. El worker (cada 5 minutos) y los cierres de corte y de caja de proveedores guardan en `alert_log`: llegada tarde (más de 20 minutos; no cuenta si la persona ya estaba trabajando desde un registro anterior de ese día, como en un doble turno), falta (sin entrada en el horario), salida anticipada (más de 10 minutos antes y con al menos 30 de trabajo), corte con diferencia mayor a $25, turno trabajado sin corte, tarea sin terminar al pasar su fecha y cierre de proveedores con diferencia mayor a $100. Retardos, faltas, salidas anticipadas y turnos sin corte solo se evalúan para personas con horario ese día; las tareas, para quien las tenga asignadas. Se revisan los últimos 3 días (7 para tareas). Los umbrales están en `apps/api/src/alerts.ts`. Las tablas `alerts`, `alert_settings` y `notification_outbox` del aviso por correo retirado se borran con la migración 017 solo si están vacías; si alguna tenía datos, se conserva sin uso.
