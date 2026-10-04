import { access, chmod, chown, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export const mediaDir = resolve(
  process.env.MEDIA_LOCAL_DIR ||
    (process.env.NODE_ENV === 'production'
      ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.MEDIA_VOLUME_ROOT || '/data'}/media`
      : '/workspace/.shifttrack-media'),
);

// Rechazar el disco efímero del contenedor en producción, incluso si hay una ruta configurada.
export async function prepareMediaStorage() {
  if (process.env.NODE_ENV === 'production') {
    const configuredRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.MEDIA_VOLUME_ROOT;
    if (!configuredRoot || !isAbsolute(configuredRoot) || resolve(configuredRoot) === '/')
      throw Error('Configura un volumen persistente para fotografías en /data.');
    const root = await realpath(configuredRoot);
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    const mounted = mounts.split('\n').some((line) => {
      const mountPath = line
        .split(' ')[4]
        ?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
      return mountPath === root;
    });
    if (!mounted || !mediaDir.startsWith(root + sep))
      throw Error('Las fotografías requieren una carpeta dentro de un volumen montado.');
    await mkdir(mediaDir, { recursive: true, mode: 0o700 });
    if (!(await realpath(mediaDir)).startsWith(root + sep))
      throw Error('Ruta de fotografías fuera del volumen.');
    // El entrypoint hace esta preparación como root y baja privilegios antes de iniciar la API.
    if (process.getuid?.() === 0) {
      await chown(mediaDir, 1000, 1000);
      await chmod(mediaDir, 0o700);
    }
  } else {
    await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  }
  await access(mediaDir, constants.W_OK | constants.R_OK);
}
