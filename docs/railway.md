# Despliegue Railway pendiente

El usuario eligió Railway para alojar la aplicación y PostgreSQL. GitHub conserva el código. El proyecto visible es `f6fb6571-ad5a-4b49-91ef-7803a318a32f`, entorno `c27e9244-2c82-4eb3-ae4f-b40226b00b0f`. Estos identificadores son metadatos, no autorizan acceso.

`railway.json` usa `infra/Dockerfile`. La imagen compila la interfaz con `.env.production` y la API sirve ambos componentes en el puerto inyectado por Railway. La comprobación de salud consulta PostgreSQL. El proceso rechaza una cuenta runtime propietaria o con bypass RLS. No usar directamente la identidad administrativa predeterminada de PostgreSQL como cuenta de la API.

Antes de publicar esta configuración, consultar los registros reales mediante acceso autorizado al proyecto, crear/configurar PostgreSQL con dos identidades y aplicar migraciones. No ejecutar datos de ejemplo en producción. La cuenta del propietario se crea mediante el bootstrap seguro. Revisar costos antes de crear recursos.

Firebase se mantiene para Authentication. La API necesita credenciales de firma y administración de Firebase configuradas de forma segura en Railway. No colocar claves privadas en Git ni en mensajes. El almacenamiento privado de fotografías aún requiere adaptación para Railway o configurar un bucket privado de Google Cloud y sus credenciales; el código actual exige `STORAGE_BUCKET` en producción. No quitar esa comprobación para conseguir un arranque aparente. Validar respaldos, permisos, autenticación y flujo operativo antes del piloto.

Para controlar este proyecto desde Codex, usar un token de proyecto de Railway, limitado a este entorno, guardado como secreto `RAILWAY_PROJECT_TOKEN` en los ajustes del entorno Codex. La API GraphQL recibe este token en `Project-Access-Token` en `https://backboard.railway.com/graphql/v2`. No registrar cabeceras ni tokens. Verificar primero lecturas de estado/despliegue y no confundir una conexión de GitHub con permisos API de Railway.

## Diagnóstico confirmado el 4 de octubre de 2026

El token de proyecto permitió leer servicios, despliegues, variables y registros. El único servicio es `ShiftTrack-2.0`; no hay PostgreSQL. El despliegue `2d9ac467-696e-4eb5-a414-a6daf094c571` está `CRASHED`: los registros contienen `STORAGE_BUCKET es obligatorio en producción.` No hay variables de aplicación ni credenciales Firebase configuradas. Solo se imprimieron nombres de variables y el error conocido, nunca valores ni registros completos.

El usuario indicó un presupuesto de hasta 10 USD/mes para pruebas. Según `https://railway.com/pricing`, consultado hoy, Hobby cuesta un mínimo de 5 USD mensuales e incluye 5 USD de uso. Los importes de CPU, memoria, almacenamiento y tráfico se cobran por consumo. No garantizar un total de 10 USD sin comprobar límites de gasto y consumo real; indicar presupuesto no establece un límite en Railway. Revisar el plan de la cuenta y costos antes de crear base/almacenamiento.

La API acepta `FIREBASE_SERVICE_ACCOUNT_JSON` como secreto runtime en Railway. El JSON debe pertenecer al proyecto indicado por `FIREBASE_PROJECT_ID`; una credencial inválida falla sin mostrar su contenido. La alternativa Google Cloud sigue usando credenciales predeterminadas. No usar esta variable en el navegador ni poner su valor en los documentos, el chat o Git. Esta credencial mantiene Firebase Authentication mientras se migra el alojamiento a Railway.
