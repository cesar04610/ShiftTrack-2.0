import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
process.env.NODE_ENV = 'test';
const { app } = await import('../apps/api/src/server.js');
const { modules } = await import('../apps/api/src/modules.js');
const { media } = await import('../apps/api/src/media.js');
const { commandSchema } = await import('../apps/api/src/commands.js');
const paths: Record<string, any> = {};
function inspect(stack: any[], prefix: string) {
  for (const layer of stack) {
    if (!layer.route) continue;
    const path = (prefix + layer.route.path).replace(/:([A-Za-z_]+)/g, '{$1}');
    const publicPath = [
      '/auth/login',
      '/devices/challenge',
      '/devices/session',
      '/health',
    ].includes(path);
    const devicePath =
      path.startsWith('/devices/state') ||
      path.startsWith('/devices/pause-ack') ||
      path === '/sync/push' ||
      path === '/media/upload';
    paths[path] ??= {};
    for (const method of Object.keys(layer.route.methods))
      paths[path][method] = {
        operationId: `${method}_${path.replace(/[^A-Za-z0-9]/g, '_')}`,
        summary: `${method.toUpperCase()} ${path}`,
        security: publicPath ? [] : devicePath ? [{ deviceTransport: [] }] : [{ sessionToken: [] }],
        parameters: Array.from(path.matchAll(/\{(\w+)\}/g)).map((m) => ({
          name: m[1],
          in: 'path',
          required: true,
          schema: { type: 'string' },
        })),
        responses: {
          '200': { description: 'Operación confirmada o datos autorizados' },
          '400': { description: 'Validación' },
          '401': { description: 'Identidad requerida' },
          '403': { description: 'Permiso denegado' },
          '409': { description: 'Conflicto: conservar captura local' },
          '500': { description: 'Error del servicio' },
        },
      };
  }
}
inspect((app as any).router.stack, '');
for (const path of Object.keys(paths))
  if (path.startsWith('/api/v1')) {
    paths[path.slice(7)] = paths[path];
    delete paths[path];
  }
inspect((modules as any).stack, '');
inspect((media as any).stack, '/media');
paths['/sync/push'].post.requestBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['commands'],
        properties: {
          commands: {
            type: 'array',
            maxItems: 20,
            items: { $ref: '#/components/schemas/Command' },
          },
        },
      },
    },
  },
};
paths['/auth/login'].post.requestBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', maxLength: 100 },
          password: { type: 'string', maxLength: 256, writeOnly: true },
        },
      },
    },
  },
};
const schema = z.toJSONSchema(commandSchema);
delete (schema as any).$schema;
const document = {
  openapi: '3.1.0',
  info: {
    title: 'ShiftTrack API',
    version: '0.1.0',
    description:
      'Rutas derivadas de los routers implementados. Contrato de comandos generado de Zod. Los payloads de módulos se validan en sus handlers; este inventario todavía no describe todos sus cuerpos.',
  },
  servers: [{ url: '/api/v1' }],
  paths,
  components: {
    securitySchemes: {
      sessionToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Token opaco de sesión (sin vencimiento automático; revocable)',
      },
      deviceTransport: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Device TOKEN; solo transporte de pendientes y confirmaciones de equipo',
      },
    },
    schemas: { Command: schema },
  },
};
await writeFile('docs/openapi.json', JSON.stringify(document, null, 2) + '\n');
console.log('Inventario OpenAPI y contrato de comandos generados.');
