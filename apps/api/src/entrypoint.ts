import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareMediaStorage } from './storage.js';

const target = process.argv[2] || 'dist/apps/api/src/server.js';
if (target.endsWith('/api/src/server.js')) await prepareMediaStorage();
if (process.getuid?.() === 0) {
  process.setgroups!([]);
  process.setgid!(1000);
  process.setuid!(1000);
}
// La API y el trabajador ejecutan como node; root se usa solo para preparar el volumen.
await import(pathToFileURL(resolve(target)).href);
