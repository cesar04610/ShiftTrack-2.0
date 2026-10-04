# Despliegue

El destino vigente es Railway, sin Firebase. Ver [railway.md](railway.md) para configuración, identidad, almacenamiento y limitaciones.

La aplicación web y la API comparten una imagen Docker; PostgreSQL guarda usuarios y datos, y un volumen privado conserva las fotografías. No se necesita ninguna clave de Google ni un emulador. Railway tiene configurado `infra/Dockerfile` y comprueba `/api/v1/health`; no usa los archivos `railway.json` obsoletos.

Los documentos originales 02 y 03 permanecen como referencia histórica. El usuario cambió posteriormente el alojamiento y pidió eliminar Firebase. No ejecutar instrucciones antiguas de Cloud Shell ni crear recursos Google Cloud para esta versión.
