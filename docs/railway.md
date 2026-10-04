# Railway sin Firebase

El usuario pidió alojar la aplicación en Railway y retirar Firebase. Los documentos originales 02/03 describen la arquitectura anterior y permanecen como referencia. No se requieren cuentas de servicio, claves de Google, Auth Emulator ni bucket GCS.

## Proyecto y estado remoto verificado

- Proyecto: `f6fb6571-ad5a-4b49-91ef-7803a318a32f` (`determined-love`).
- Entorno: `c27e9244-2c82-4eb3-ae4f-b40226b00b0f` (`production`).
- Servicio: `a4b30cc3-4631-460b-b4cf-983cd536fd9c` (`ShiftTrack-2.0`).
- Acceso mediante token de proyecto verificado: lectura de servicios, despliegues, nombres de variables y registros.
- PostgreSQL 17 privado y dos volúmenes persistentes creados; API saludable en `https://shifttrack-20-production.up.railway.app`. Ambos volúmenes están en región `sfo`. La rama `main` de GitHub dispara el despliegue automáticamente.
- El workspace está en Hobby. El propietario guardó un hard limit de Compute de 10 USD y una alerta de 8 USD; ambos se verificaron mediante API. No cambiar esos límites globales desde Codex.

## Imagen y variables

Railway tiene configurado `dockerfilePath=infra/Dockerfile` mediante su API. Los archivos `railway.json` y la selección de Config as Code están obsoletos y se retiraron del repositorio. La misma imagen contiene frontend PWA y API, sirve ambas en el puerto `PORT` que inyecta Railway y comprueba `/api/v1/health`. API y fotografías requieren autenticación para sus rutas privadas; la carpeta del volumen nunca se publica como archivos estáticos.

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

La migración 006 agrega sucursales activas, cantidad de cajas y reservas online; aplicar antes de iniciar esta versión, con la identidad de migraciones. El rol de aplicación recibe los permisos de `register_leases` sin propiedad de la tabla. Las credenciales administrativas usadas para migrar deben retirarse del servicio después del despliegue.

La migración 005 agrega `auth_sessions`; no altera usuarios ni importes. El login verifica Argon2 y emite un token opaco aleatorio de 256 bits con vencimiento fijo de ocho horas. SQL conserva SHA-256 del token; el navegador lo guarda en `sessionStorage`, por pestaña. Cada petición revisa vencimiento, estado y versión de la cuenta. El cierre online borra esa sesión, cambiar contraseña revoca todas y la baja lógica impide acceso de inmediato. El cierre offline solo borra el acceso local; el token remoto conserva su vencimiento original.

Los permisos y concesiones offline siguen firmados por usuario y equipo. No se borran IndexedDB ni pendientes; una cuenta modificada envía capturas antiguas a revisión. La cuenta `cesar` se creó con la contraseña proporcionada privadamente por el propietario. `scripts/provision.ts` es el proceso administrativo temporal: aplica migraciones, configura el rol restringido y crea al dueño únicamente si falta. No restablece contraseñas existentes. Las credenciales de migración no se entregan al servicio API; no hay contraseña predeterminada de producción. No publicar una ruta pública sin protección para crear al dueño.

## Presupuesto y puesta en marcha

El usuario indicó hasta 10 USD/mes para pruebas. Hobby tiene un mínimo de 5 USD que incluye 5 USD de uso, según `https://railway.com/pricing`. Memoria, CPU, volúmenes, backups y tráfico se cobran por consumo. El límite de RAM no es un límite de factura. En el contenedor local, después del flujo E2E, se observaron aproximadamente 64 MiB para API y 32 MiB para PostgreSQL; esto no garantiza el consumo real mensual.

El propietario revisó y estableció el límite antes de crear recursos. Un hard limit detiene servicios al alcanzarlo y se aplica al workspace; confirmar qué otros proyectos afecta y cómo contempla los créditos incluidos y la cuota de Hobby. No prometer un total mensual exacto, ni confundir una alerta con un límite efectivo.

Objetivo inicial: una réplica API, PostgreSQL pequeño y dos volúmenes, sin importar datos antiguos. Configurar límites de memoria/CPU y monitorear consumo. El correo permanece deshabilitado hasta tener SMTP y aprobación operativa; programar el worker por separado antes de aceptar el piloto completo.

El servicio `ShiftTrack-Worker` usa la misma imagen con `node dist/apps/api/src/entrypoint.js dist/apps/worker/run.js`, cron `*/5 * * * *` y política de reinicio `NEVER`. Finaliza después de cada ejecución, usa el rol SQL restringido y no tiene dominio público, puerto HTTP ni SMTP. No crear un cron en cada réplica API.

Después del despliegue: comprobar HTTPS, salud SQL, login/logout, roles, evidencia privada y recarga/relevo offline. Configurar respaldos de SQL y del volumen, verificar restauración y completar aceptación operativa antes de usar dinero real. Un volumen persistente no sustituye un respaldo.

## Acceso desde Codex

`RAILWAY_PROJECT_TOKEN` se guarda en los ajustes seguros de Codex. Usarlo solo contra `https://backboard.railway.com/graphql/v2`, cabecera `Project-Access-Token`, User-Agent `ShiftTrack-Codex/0.1`. Nunca imprimir tokens, valores de variables ni registros sensibles. GitHub conectado permite desplegar; el token API permite consultar/configurar este proyecto. Las operaciones de facturación pueden necesitar permisos diferentes.

## Respaldos

La API de Railway rechazó `volumeInstanceBackupScheduleUpdate` con «Not Authorized». El propietario debe activar los respaldos diarios de SQL y fotografías desde Railway si están disponibles en el plan. No presentar el volumen persistente como respaldo ni afirmar una restauración verificada. Antes de uso real, ejecutar y validar una restauración en un entorno aislado.
