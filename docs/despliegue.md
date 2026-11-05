# Despliegue

El destino vigente es Railway, sin Firebase. Ver [railway.md](railway.md) para configuración, identidad, almacenamiento y limitaciones.

La aplicación web y la API comparten una imagen Docker; PostgreSQL guarda usuarios y datos, y un volumen privado conserva las fotografías. No se necesita ninguna clave de Google ni un emulador. Railway tiene configurado `infra/Dockerfile` y comprueba `/api/v1/health`; no usa los archivos `railway.json` obsoletos.
