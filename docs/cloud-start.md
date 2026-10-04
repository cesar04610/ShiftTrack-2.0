# Inicio de este entorno de desarrollo

Usa `/workspace/ShiftTrack-2.0`; cada tarea cloud ya está aislada. No crear worktrees adicionales. Lee `README.md` y `docs/estado.md`. No confundir el entorno local validado con un despliegue Firebase real o un piloto aceptado.

Los paquetes y archivos compilados permanecen en el sistema de archivos; PostgreSQL, Auth Emulator y servidores deben volver a iniciarse. No asumir que procesos, sesiones o conexiones sobreviven a publicación/restauración. No sobrescribir `.env` existente ni ejecutar seeds contra producción.

1. Si no existen dependencias o contenedor de PostgreSQL, ejecuta `bash scripts/cloud-install.sh`. El script es exclusivo de desarrollo con los valores de `.env.example`. Si existe el contenedor, inicia solo ese: `docker start shifttrack-postgres`. Comprueba `docker exec shifttrack-postgres pg_isready -U shifttrack -d shifttrack`.
2. Ejecuta migraciones verificadas y seed idempotente solo para la base local: `npm run db:migrate && npm run db:seed`. La cuenta API `shifttrack_app` no tiene ownership ni bypass RLS. La API rechaza roles inseguros al iniciar.
3. Inicia Auth Emulator en un proceso mantenido por la herramienta de terminal: `XDG_CONFIG_HOME=/workspace/.shifttrack-config XDG_CACHE_HOME=/tmp/shifttrack-cache FIREBASE_CLI_DISABLE_USAGE=1 npm run emulators`. Espera la confirmación de Auth listo en puerto 9099. No iniciar otro si ya responde correctamente.
4. En otro proceso, `npm run dev` inicia API en 8080 y Vite en 5173. Verifica salud real con `curl --fail http://127.0.0.1:8080/api/v1/health`. Un puerto abierto solo no prueba funcionamiento.
5. Para comprobar apertura offline con Auth Emulator, usa `npm run build:local` y otro proceso `npx vite preview --config apps/web/vite.config.ts --port 5174`. `npm run build` compila con la configuración pública real de `shifttrackcloud` en `.env.production`; no usar ese artefacto para pruebas de emulador. Desarrollo de Vite no verifica la PWA offline. No proporcionar enlaces de preview localhost al usuario.
6. Validación: `npm test` (PostgreSQL real + Auth Emulator), `npm run test:e2e` (API + preview PWA), `npm run worker:tick` y `npm audit --omit=dev`. El test de navegador crea una sucursal nueva y dos empleados, captura pago/foto offline, recarga, releva, reconecta y prueba vencimiento/reloj atrasado. Se usan Chromium del sistema o `CHROMIUM_PATH`.

Las cuentas públicas de ejemplo están en README y son solo de emulador. Registra el navegador desde Configuración con el dueño antes de preparar cada empleado. No renovar ocho horas por conectividad, cambiar usuario o login offline. Nunca borrar pendientes ni reemplazar su saldo al ver un conflicto.

La base local del contenedor depende del volumen Docker: si desaparece, recrear las cuentas de ejemplo no equivale a recuperar datos operativos. El respaldo/recuperación cloud y la sustitución de equipos deben validarse antes del piloto. La instalación original de ShiftTrack permanece separada.

Para construir la imagen en este sandbox se verificó la ruta del proxy y su CA, sin desactivar TLS. Si BuildKit no resuelve `proxy`, agrega la IP resuelta en la máquina con `--add-host`, manteniendo `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` y el certificado mediante `--secret id=npm_ca,src=...`. Nunca guardar valores de proxy/credenciales o certificados privados en el repositorio. El Dockerfile acepta una CA de confianza opcional; fuera de este sandbox normalmente no hace falta.
