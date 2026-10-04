# Railway sin Firebase

El usuario pidió alojar la aplicación en Railway y retirar Firebase. Los documentos originales 02/03 describen la arquitectura anterior y permanecen como referencia. No se requieren cuentas de servicio, claves de Google, Auth Emulator ni bucket GCS.

## Proyecto y estado remoto verificado

- Proyecto: `f6fb6571-ad5a-4b49-91ef-7803a318a32f` (`determined-love`).
- Entorno: `c27e9244-2c82-4eb3-ae4f-b40226b00b0f` (`production`).
- Servicio: `a4b30cc3-4631-460b-b4cf-983cd536fd9c` (`ShiftTrack-2.0`).
- Acceso mediante token de proyecto verificado: lectura de servicios, despliegues, nombres de variables y registros.
- El último despliegue consultado es de la versión anterior, está `CRASHED` y exige `STORAGE_BUCKET`. Todavía no hay PostgreSQL ni volumen configurado. No atribuir ese error a la versión nueva ni afirmar que está publicada.
- El workspace está en Hobby. La lectura de facturación muestra consumo actual 0 y ningún límite de uso configurado. El token no permite enumerar los demás proyectos del workspace; no cambiar límites globales que puedan afectar otros proyectos sin intervención del propietario.

## Imagen y variables

`railway.json` construye `infra/Dockerfile`. La misma imagen contiene frontend PWA y API, sirve ambas en el puerto `PORT` que inyecta Railway y comprueba `/api/v1/health`. API y fotografías requieren autenticación para sus rutas privadas; la carpeta del volumen nunca se publica como archivos estáticos.

Variables runtime:

| Variable                    | Configuración                                                       |
| --------------------------- | ------------------------------------------------------------------- |
| `NODE_ENV`                  | `production` (ya en la imagen)                                      |
| `DATABASE_URL`              | Secreto con el rol `shifttrack_app`, nunca el propietario de tablas |
| `RAILWAY_VOLUME_MOUNT_PATH` | `/data`, proporcionado por Railway al adjuntar el volumen           |
| `MEDIA_VOLUME_ROOT`         | `/data` si se usa un proveedor que no inyecta la variable anterior  |
| `MEDIA_LOCAL_DIR`           | Opcional; por defecto `<volumen>/media`                             |
| `WEB_DIST_DIR`              | `/app/apps/web/dist` (ya en la imagen)                              |

Crear un volumen para PostgreSQL y otro para fotografías, ambos en la misma región que el servicio. Mantener una sola réplica API. La API comprueba un montaje real en Linux antes de aceptar escritura en producción. El entrypoint prepara su carpeta y cambia a UID/GID 1000; la API no ejecuta como root. Los archivos usan permisos privados y la lectura comprueba tarea, empleado y sucursal.

No establecer variables Firebase. Si se había configurado una clave Google para el intento anterior, retirar esa variable y revocar la clave desde la cuenta propietaria una vez confirmada la migración. No borrar recursos o credenciales externas automáticamente.

## PostgreSQL e identidad

Crear PostgreSQL 17 con una identidad propietaria de migraciones y `shifttrack_app` sin SUPERUSER, BYPASSRLS ni ownership. Conectar por la red privada del proyecto. Aplicar las migraciones y luego `infra/runtime-role.sql` desde un proceso autorizado; la cuenta propietaria no se entrega al servicio API. No ejecutar el seed de ejemplo en Railway.

La migración 005 agrega `auth_sessions`; no altera usuarios ni importes. El login verifica Argon2 y emite un token opaco aleatorio de 256 bits con vencimiento fijo de ocho horas. SQL conserva SHA-256 del token; el navegador lo guarda en `sessionStorage`, por pestaña. Cada petición revisa vencimiento, estado y versión de la cuenta. El cierre online borra esa sesión, cambiar contraseña revoca todas y la baja lógica impide acceso de inmediato. El cierre offline solo borra el acceso local; el token remoto conserva su vencimiento original.

Los permisos y concesiones offline siguen firmados por usuario y equipo. No se borran IndexedDB ni pendientes; una cuenta modificada envía capturas antiguas a revisión. Crear el primer dueño mediante `scripts/bootstrap.ts` desde un proceso autorizado, con entrada de contraseña oculta; no hay contraseña predeterminada de producción. No publicar una ruta pública sin protección para crear al dueño.

## Presupuesto y puesta en marcha

El usuario indicó hasta 10 USD/mes para pruebas. Hobby tiene un mínimo de 5 USD que incluye 5 USD de uso, según `https://railway.com/pricing`. Memoria, CPU, volúmenes, backups y tráfico se cobran por consumo. El límite de RAM no es un límite de factura. En el contenedor local, después del flujo E2E, se observaron aproximadamente 64 MiB para API y 32 MiB para PostgreSQL; esto no garantiza el consumo real mensual.

Antes de crear recursos, el propietario debe revisar y establecer un límite de gasto en Railway Billing/Usage. Un hard limit detiene servicios al alcanzarlo y se aplica al workspace; confirmar qué otros proyectos afecta y cómo contempla los créditos incluidos y la cuota de Hobby. No prometer un total mensual exacto, ni confundir una alerta con un límite efectivo.

Objetivo inicial: una réplica API, PostgreSQL pequeño y dos volúmenes, sin importar datos antiguos. Configurar límites de memoria/CPU y monitorear consumo. El correo permanece deshabilitado hasta tener SMTP y aprobación operativa; programar el worker por separado antes de aceptar el piloto completo.

El worker usa la misma imagen con `node dist/apps/api/src/entrypoint.js dist/apps/worker/server.js`. Su endpoint de ejecución necesita transporte privado o autenticado; no exponerlo públicamente sin protección. No crear un cron en cada réplica API.

Después del despliegue: comprobar HTTPS, salud SQL, login/logout, roles, evidencia privada y recarga/relevo offline. Configurar respaldos de SQL y del volumen, verificar restauración y completar aceptación operativa antes de usar dinero real. Un volumen persistente no sustituye un respaldo.

## Acceso desde Codex

`RAILWAY_PROJECT_TOKEN` se guarda en los ajustes seguros de Codex. Usarlo solo contra `https://backboard.railway.com/graphql/v2`, cabecera `Project-Access-Token`, User-Agent `ShiftTrack-Codex/0.1`. Nunca imprimir tokens, valores de variables ni registros sensibles. GitHub conectado permite desplegar; el token API permite consultar/configurar este proyecto. Las operaciones de facturación pueden necesitar permisos diferentes.
