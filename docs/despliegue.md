# Despliegue de pruebas en Firebase / Google Cloud

Preparado para Hosting + Authentication, API Cloud Run, SQL PostgreSQL y bucket privado. El destino indicado por el usuario es `shifttrackcloud`, con la app web `supergalaviz` (`1:181600983752:web:56fe48324c78bc3b0fa3fd`). No se han creado recursos, aprobado costos ni desplegado esta aplicación. Esta guía no es evidencia de un despliegue ejecutado.

## Preparación

1. Proyecto de pruebas separado de producción. Seleccionar región de API, SQL y bucket conjuntamente; la propuesta inicial es `us-central1`. Cotizar SQL, backups, almacenamiento, Run y tráfico antes de crear recursos facturables.
2. Activar Firebase Authentication y agregar dominios autorizados de Hosting. Se usa autenticación personalizada por username, no correo como campo de login. La cuenta de servicio API debe poder firmar custom tokens y administrar/revocar usuarios de Auth; usar IAM y credenciales predeterminadas, sin archivo JSON en el repositorio.
3. Crear PostgreSQL 17, base y dos identidades: propietario de migraciones y `shifttrack_app` sin ownership, superusuario ni BYPASSRLS. La conexión runtime debe usar Cloud SQL con canal autenticado y TLS/verificación apropiados; no publicar PostgreSQL en Internet. Aplicar migraciones una vez desde un proceso autorizado (`MIGRATION_DATABASE_URL`) y ejecutar `infra/runtime-role.sql` después de cada nueva migración.
4. Crear bucket privado con prevención de acceso público y permisos limitados a la identidad API. Establecer `STORAGE_BUCKET`. Producción rechaza almacenamiento duradero local y Auth Emulator. Probar lectura de evidencia entre sucursales antes del piloto.
5. Configurar en Secret Manager/Cloud Run `DATABASE_URL`; la cuenta de migraciones no se comparte con el servicio API. Registrar variables `NODE_ENV=production`, `FIREBASE_PROJECT_ID`, `STORAGE_BUCKET`. Nunca establecer `FIREBASE_AUTH_EMULATOR_HOST` en cloud. La clave privada de firma de concesiones se genera en la migración y se guarda en SQL; incluirla en respaldo protegido y diseñar rotación antes de producción.
6. Crear el primer dueño con `npm run bootstrap` desde un terminal autorizado conectado a la base, sin contraseña en argumentos o código. No ejecutar `db:seed` en cloud. Crear sucursales y apertura mediante la aplicación.

## Artefactos

La imagen se construye desde la raíz:

```bash
docker build -f infra/Dockerfile -t shifttrack-api:pruebas .
```

Publicar imagen en Artifact Registry y desplegar `shifttrack-api` en Cloud Run con la identidad/SQL/secreto del proyecto de pruebas. Usar puerto 8080 y limitar instancias/pool a la capacidad de SQL. El reenvío Hosting requiere transporte accesible para la API; la API sigue autenticando sus operaciones.

Para el frontend, `.env.production` contiene la configuración pública suministrada de `supergalaviz`. Vite la carga en `npm run build`; la URL del emulador se establece vacía para que no se herede de `.env`. `.env` sigue siendo solo para desarrollo local. Las variables exportadas en el terminal tienen prioridad: no exportar valores de emulador al compilar para cloud. `measurementId` está disponible como configuración; no se ha habilitado Analytics en el código.

```bash
npm run build
npx firebase deploy --only hosting --project shifttrackcloud
```

`firebase.json` reenvía `/api/**` al servicio `shifttrack-api` de `us-central1`. Desplegar y verificar esa API antes de Hosting: publicar solo el frontend no hace funcionar el login ni los datos. `.firebaserc` selecciona el proyecto indicado. La configuración pública no concede permisos para administrar el proyecto, desplegar ni crear recursos. La variable de servidor `FIREBASE_PROJECT_ID=shifttrackcloud` debe establecerse en Cloud Run, con credenciales IAM; no cambiar `.env` de desarrollo por estos valores.

## Siguiente paso del usuario

En Firebase Console, revisar si `shifttrackcloud` tiene el plan Blaze y si Authentication está inicializado (sección Authentication, botón Comenzar si aparece). No crear usuarios manualmente ni activar correo/contraseña para este login personalizado. Para continuar el despliegue desde un terminal propio o Google Cloud Shell, iniciar sesión con la cuenta que administra el proyecto. No compartir archivos JSON de cuentas de servicio, tokens ni contraseñas en el chat. Antes de crear Cloud SQL u otros recursos facturables, definir y revisar la región y el costo estimado.

El trabajador usa la misma imagen con comando `node dist/apps/worker/server.js`. Desplegar como servicio privado con IAM. Cloud Scheduler invoca `/tick` cada cinco minutos con OIDC y cuenta de servicio autorizada; no crear un cron en cada réplica de la API. La generación diaria es idempotente. El worker incluye correo SMTP y resumen de tareas. Configurar `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` y, cuando se necesiten, `SMTP_USER`/`SMTP_PASSWORD` mediante secretos runtime, nunca en el repositorio. El formulario de Alertas verifica la conexión antes de habilitar envíos. Por defecto `SMTP_MAX_ATTEMPTS=1`; una política ampliada (máximo 5 intentos para rechazos SMTP transitorios explícitos) requiere decisión operativa. Un timeout o entrega incierta exige revisión manual. SMTP aceptado no prueba recepción en el buzón. La prueba actual fue contra SMTP local, sin envío externo.

## Verificación antes del piloto

- Repetir pruebas con Auth/SQL/Storage del proyecto de pruebas, incluyendo roles y objetos privados.
- Resolver pendientes del equipo antes de cambios de versión incompatibles. Validar reloj, persistencia y relevo físico en dos cuentas.
- Configurar/verificar respaldos SQL/PITR, restauración independiente y acceso privado al bucket. Los objetivos de recuperación del documento 03 son propuestas, no resultados alcanzados.
- Habilitar logs sin contraseñas/tokens/cuerpos sensibles, alertas de errores/jobs/backups y presupuesto de consumo. Un presupuesto no bloquea automáticamente los gastos.
- Aceptación por César y comparación de módulos antes de mover operación real. No modificar la instalación actual ni importar dinero antiguo.
