# ShiftTrack 2.0

Aplicación web para Firebase Hosting y Authentication, API en Cloud Run y PostgreSQL en Cloud SQL. Implementación inicial basada en los documentos de `docs/`, con referencia funcional a `cesar04610/shifttrack` en `2cf7a06afcce071fbdc02e7e4aeff2a738bca090`.

Esta versión permite desarrollar y probar los módulos principales y el flujo de caja offline. Todavía no es una versión certificada para operar dinero real: faltan la validación operativa del propietario, recuperación de dispositivos y configuración/verificación cloud. El estado detallado está en [docs/estado.md](docs/estado.md).

## Desarrollo

Requiere Node 24, npm, Docker y Java 21 para la herramienta de emuladores. Usa el checkout existente: cada tarea cloud ya tiene aislamiento; no hace falta otro worktree.

```bash
npm ci
cp .env.example .env # Solo si no existe; nunca sobrescribir la configuración propia.
docker compose up -d
npm run db:migrate
npm run db:seed
```

En terminales separadas:

```bash
npm run emulators
npm run dev
```

La API usa el puerto 8080 y Vite el 5173. Si ya existe el contenedor `shifttrack-postgres` creado durante onboarding, usa `docker start shifttrack-postgres` en lugar de iniciar otro PostgreSQL en ese puerto. Para comprobar la PWA offline, usa la compilación real:

```bash
npm run build:local
npx vite preview --config apps/web/vite.config.ts --port 5174
```

Vite en desarrollo no comprueba la apertura offline; las pruebas de navegador usan la compilación con service worker. Los procesos deben volver a iniciarse después de restaurar el entorno. La base local de Docker se conserva mientras exista su volumen; no es un respaldo de producción.

En el sandbox cloud puedes necesitar `XDG_CONFIG_HOME=/workspace/.shifttrack-config XDG_CACHE_HOME=/tmp/shifttrack-cache FIREBASE_CLI_DISABLE_USAGE=1 npm run emulators`. `.npmrc` coloca la caché de npm en `/tmp`.

## Cuentas de ejemplo

Exclusivamente con Auth Emulator y la base local: `cesar` (dueño), `admin` (administrador), `ana` y `luis` (empleados). Contraseña pública de estos datos de prueba: `ShiftTrack-demo-2026!`. El seed no se ejecuta en producción ni sobrescribe cuentas existentes. No hay contraseña predeterminada para producción.

1. Ingresa como `cesar`, selecciona Sucursal Centro y registra este navegador/equipo en Configuración. La caja de proveedores no depende de ser Caja 3.
2. En Caja general registra efectivo total, la parte incluida en proveedores y saldo bancario. La parte de proveedores no se suma otra vez al total.
3. Cada empleado inicia sesión individualmente con conexión en ese equipo. Su concesión dura ocho horas desde esa validación, independientemente del acceso de otros empleados.
4. El empleado abre su turno de proveedores. Registra pagos/adiciones, cuenta y cierra. Sale de su sesión; el entrante ingresa con sus credenciales y abre un turno vinculado al último cierre.
5. Sin Internet se muestra guardado local pendiente. Al reconectar se envían comandos firmados con identificadores estables, incluyendo los de empleados anteriores. No hace falta renovar su concesión para enviar capturas válidas anteriores.

Cerrar sesión no cierra automáticamente la caja ni borra pendientes. Cierra el turno explícitamente antes del relevo. Si quedó un turno de otro día, se exige conteo de reconciliación antes de nuevos movimientos.

## Pruebas

Con PostgreSQL y Auth Emulator en ejecución:

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

Importes MXN en centavos enteros, enviados como cadenas. Fecha operativa calculada en la zona IANA de la sucursal. La etiqueta del corte se calcula en el servidor con la hora original (Mañana desde 07:30 hasta antes de 17:00). Fichaje del mismo día obligatorio; horario y foto opcionales.

**Aclaración del propietario en esta conversación:** el efectivo contado corresponde únicamente a ventas de ese turno. General recibe ese contado, banco recibe tarjeta, y cada ticket de proveedores descuenta su importe separadamente. La diferencia de corte no se suma otra vez.

Cada comando y su proyección se guardan juntos en IndexedDB. Contraseña local: PBKDF2 y AES-GCM para proteger la clave de firma del empleado; no se guarda la contraseña. La concesión se firma con ECDSA P-256 en el servidor. El transporte de dispositivo solo permite subir/confirmar pendientes; no reemplaza la identidad del empleado ni habilita consultas administrativas.

Un conflicto conserva el comando y bloquea la continuación dependiente; nunca se aplica un saldo arbitrario. La descarga de pendientes contiene comandos y firmas, no claves privadas ni contraseñas. Fotografías pendientes se conservan en IndexedDB y no están incluidas en ese archivo de respaldo. El almacenamiento borrado o el equipo perdido requieren recuperación administrativa: ver límites en `docs/estado.md`.

## Firebase / Google Cloud

El proyecto de destino es `shifttrackcloud` y la app registrada se llama `supergalaviz`. `npm run build` compila para ese proyecto con `.env.production`; `npm run build:local` conserva el emulador para las pruebas locales. La configuración de Hosting está en `firebase.json`; despliegue y requisitos en [docs/despliegue.md](docs/despliegue.md). No se han creado recursos ni habilitado facturación. Las variables `VITE_FIREBASE_*` son configuración pública del SDK; no incluir claves privadas. La API usa identidad de servicio y secretos de Cloud Run. No se usa Firestore.

El correo requiere SMTP configurado en el servidor y habilitación por sucursal. Por defecto hay un intento automático; las entregas inciertas quedan para revisión. Los reintentos adicionales son configurables, sin promesa de entrega exactamente una vez. El inventario de API y el contrato de comandos están en `docs/openapi.json`; se regeneran con `npm run contracts`.
