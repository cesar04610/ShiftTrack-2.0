# Mostrador 2.0

Aplicación web y API en Railway con PostgreSQL, sesiones propias y fotografías privadas en un volumen persistente. Implementación inicial basada en los documentos de `docs/`, con referencia funcional a `cesar04610/shifttrack` en `2cf7a06afcce071fbdc02e7e4aeff2a738bca090`.

Esta versión permite desarrollar y probar los módulos principales y el flujo de caja offline. Todavía no es una versión certificada para operar dinero real: faltan la validación operativa del propietario, recuperación de dispositivos y configuración/verificación cloud. El estado detallado está en [docs/estado.md](docs/estado.md).

## Desarrollo

Requiere Node 24, npm y Docker. Usa el checkout existente: cada tarea cloud ya tiene aislamiento; no hace falta otro worktree.

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

La API usa el puerto 8080 y Vite el 5173. Si ya existe el contenedor `shifttrack-postgres` creado durante onboarding, usa `docker start shifttrack-postgres` en lugar de iniciar otro PostgreSQL en ese puerto. Para comprobar la PWA offline, usa la compilación real:

```bash
npm run build:local
npx vite preview --config apps/web/vite.config.ts --port 5174
```

Vite en desarrollo no comprueba la apertura offline; las pruebas de navegador usan la compilación con service worker. Los procesos deben volver a iniciarse después de restaurar el entorno. La base local de Docker se conserva mientras exista su volumen; no es un respaldo de producción.

`.npmrc` coloca la caché de npm en `/tmp`. No se necesita Firebase, Java ni un emulador de autenticación.

## Cuentas de ejemplo

Exclusivamente con la base local de desarrollo: `cesar` (dueño), `admin` (administrador), `ana` y `luis` (empleados). Contraseña pública de estos datos de prueba: `ShiftTrack-demo-2026!`. El seed no se ejecuta en producción ni sobrescribe cuentas existentes. No hay contraseña predeterminada para producción.

1. Ingresa como `cesar`, selecciona Sucursal Centro y configura sus cajas. La caja de proveedores no depende de ser Caja 3.
2. En Caja general registra efectivo total, la parte incluida en proveedores y saldo bancario. La parte de proveedores no se suma otra vez al total.
3. Cada empleado inicia sesión con conexión y selecciona su caja. El equipo y su acceso offline se preparan automáticamente, sin vencimiento por horas.
4. El empleado abre su turno de proveedores. Registra pagos/adiciones, cuenta y cierra. Sale de su sesión; el entrante ingresa con sus credenciales y abre un turno vinculado al último cierre.
5. Sin Internet se muestra guardado local pendiente. Al reconectar se envían comandos firmados con identificadores estables, incluyendo los de empleados anteriores. No hace falta renovar su concesión para enviar capturas válidas anteriores.

Cerrar sesión no cierra automáticamente la caja ni borra pendientes. Cierra el turno explícitamente antes del relevo. Si quedó un turno de otro día, se exige conteo de reconciliación antes de nuevos movimientos.

## Sucursales y cajas

El dueño configura la cantidad de cajas y elige la caja de proveedores entre 1 y ese total. Cada empleado selecciona su caja al entrar. Con conexión, la reserva es exclusiva por sucursal y se comprueba cada 30 segundos, sin vencimiento automático. Cerrar sesión o cerrar la ventana la libera cuando el aviso llega al servidor. Si el navegador se cierra sin red o de forma abrupta, el mismo usuario puede recuperar su caja al volver a entrar desde ese equipo. Otra pestaña abierta no puede apropiarse de la caja. Si alguien dejó una sesión abierta, el administrador puede liberar la caja desde Configuración confirmando su contraseña. El menú de proveedores depende de seleccionar la caja de proveedores configurada.

En **Caja proveedores**, los administradores y el dueño pueden usar **Importar proveedores desde Excel**. Descarga la plantilla, completa Empresa, Representante, Teléfono y Tipo de producto, carga el `.xlsx` y revisa la vista previa antes de confirmar. Solo Empresa es obligatoria. Admite hasta 2,000 proveedores y 2 MB, requiere conexión y omite empresas repetidas en la sucursal o el archivo sin modificar registros existentes. Las filas con errores deben corregirse antes de guardar; repetir la misma confirmación no duplica el resultado. También reconoce la hoja `suppliers` y los encabezados de la exportación antigua (`company_name`, `rep_name`, `rep_phone`, `product_type`).

El acceso offline se prepara automáticamente para la caja seleccionada y no vence por tiempo. Sin conexión se permite la última caja preparada y se advierte que su ocupación no puede comprobarse. Tras un login offline, al reconectar se pueden enviar los pendientes; antes de nuevas capturas online se requiere volver a iniciar sesión para reservar la caja. Los cortes quedan vinculados a la caja firmada en la concesión.

Eliminar una sucursal exige superadministrador y su contraseña actual. Se desactiva, revoca sesiones y equipos, detiene sus procesos y conserva usuarios, movimientos y fotografías. Un turno de proveedores abierto debe cerrarse primero. El dueño puede consultar el historial desde Configuración. Las capturas previas que lleguen después quedan para revisión.

## Empleados por sucursal

El nombre de usuario es único dentro de cada sucursal. El mismo empleado puede tener una cuenta en Quates y otra en Madeira, con registros y permisos separados. Si sus credenciales coinciden en varias tiendas, el inicio de sesión pide elegir la sucursal. El acceso offline preparado se conserva por usuario y tienda.

En Usuarios, **Eliminar empleado** pide confirmación, retira la cuenta de la lista, revoca sus sesiones y permite reutilizar su nombre en esa sucursal. Se conserva la fila original con `deleted_at` para mantener sus registros, fotografías y autoría en informes. Su cuenta en otras sucursales no cambia. **Desactivar** conserva la cuenta en la lista como inactiva. Un turno de proveedores abierto debe cerrarse antes de eliminar a su responsable.

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

**Aclaración del propietario en esta conversación:** el efectivo contado corresponde únicamente a ventas de ese turno. General recibe ese contado, banco recibe tarjeta, y cada ticket de proveedores descuenta su importe separadamente. La diferencia de corte no se suma otra vez.

Cada comando y su proyección se guardan juntos en IndexedDB. Contraseña local: PBKDF2 y AES-GCM para proteger la clave de firma del empleado; no se guarda la contraseña. La concesión se firma con ECDSA P-256 en el servidor. El transporte de dispositivo solo permite subir/confirmar pendientes; no reemplaza la identidad del empleado ni habilita consultas administrativas.

Un conflicto conserva el comando y bloquea la continuación dependiente; nunca se aplica un saldo arbitrario. La descarga de pendientes contiene comandos y firmas, no claves privadas ni contraseñas. Fotografías pendientes se conservan en IndexedDB y no están incluidas en ese archivo de respaldo. El almacenamiento borrado o el equipo perdido requieren recuperación administrativa: ver límites en `docs/estado.md`.

## Railway

Despliegue y límites en [docs/railway.md](docs/railway.md). La imagen sirve la interfaz y la API juntas; usa PostgreSQL para identidad y datos, y un volumen privado para fotografías. No requiere Firebase ni claves de Google. Los documentos originales 02 y 03 conservan el diseño inicial como referencia; la elección posterior del propietario de usar Railway sin Firebase lo sustituye.

El login emite un token aleatorio de 256 bits, sin vencimiento automático, guardado por pestaña en `sessionStorage`; SQL solo conserva su hash. Cada petición revisa vencimiento, versión de credenciales y estado de la cuenta. El cierre online revoca esa sesión; cambiar contraseña revoca todas. El cierre sin Internet borra el acceso local, pero no puede contactar al servidor para revocar: el administrador puede liberar la caja pendiente desde Configuración. Las contraseñas usan Argon2. Solo servir la aplicación publicada con HTTPS.

La migración 005 agrega sesiones sin cambiar usuarios ni datos financieros. No se borran IndexedDB, concesiones ni pendientes. Después de cambiar contraseña o desactivar cuenta, las capturas antiguas permanecen para revisión y no se aceptan automáticamente. Las rutas de fotos siempre comprueban usuario, tarea y sucursal.

En producción se exige un volumen montado real; no se admiten fotografías en el disco efímero del contenedor. La imagen prepara la carpeta del volumen y luego ejecuta la API como usuario `node`. Configurar una sola réplica para ese volumen. Los respaldos del volumen y de SQL deben verificarse antes de operar dinero real.

El correo requiere SMTP configurado en el servidor y habilitación por sucursal. Por defecto hay un intento automático; las entregas inciertas quedan para revisión. Los reintentos adicionales son configurables, sin promesa de entrega exactamente una vez. El inventario de API y el contrato de comandos están en `docs/openapi.json`; se regeneran con `npm run contracts`.

Mostrador 2.0 ofrece la operación diaria a empleados, administradores y súper administradores. Las cuentas administrativas pueden continuar sin caja o seleccionar una para registrar cortes; los pagos requieren la caja de proveedores. El menú de gestión conserva Usuarios, Horarios, Gestionar tareas, Reportes, Cortes, Caja general y Configuración; Alertas está reservado al súper administrador.

En Horarios, la pizarra semanal permite arrastrar fichas del personal activo, incluidos administradores y súper administradores, o seleccionar una persona y pulsar + en el turno. Mañana: 07:30–15:00 (medio turno 12:00–15:00). Tarde: 15:00–21:30 (medio turno 18:30–21:30). Seleccionar una ficha asignada permite cambiar entre turno completo y medio turno; arrastrarla a otra casilla mueve el horario. Requiere conexión y rechaza horarios superpuestos sin duplicar fichas. Los horarios anteriores y la captura manual se conservan.

La pizarra se adapta al tamaño de la pantalla con fichas compactas, nombres cortos y un color estable por persona. Ampliar pizarra aprovecha toda la ventana; puedes volver con Reducir pizarra o Escape. El nombre completo se conserva en las opciones del turno y en la descripción de cada ficha.
