import express from 'express';
import sharp from 'sharp';
import { Storage } from '@google-cloud/storage';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { deviceIdentity, validateCommand, identity } from './security.js';
import { context, transaction } from './db.js';
import { commandSchema } from './commands.js';
import { assert } from '../../../packages/domain/index.js';
export const media = express.Router();
media.use(express.json({ limit: '8mb' }));
const localDir = process.env.MEDIA_LOCAL_DIR || '/workspace/.shifttrack-media';
const cloud = process.env.STORAGE_BUCKET ? new Storage().bucket(process.env.STORAGE_BUCKET) : null;
if (process.env.NODE_ENV === 'production' && !cloud)
  throw Error('STORAGE_BUCKET es obligatorio en producción.');
media.post('/upload', async (req, res) => {
  const device = await deviceIdentity(req.headers.authorization),
    body = z.object({ command: commandSchema, base64: z.string().max(7_000_000) }).parse(req.body);
  const c = body.command,
    p = c.payload;
  assert(
    c.type === 'task.complete' && p.media_id,
    'FORBIDDEN',
    'La foto debe estar vinculada a una tarea.',
    403,
  );
  await validateCommand(c, device.id);
  const id = z.uuid().parse(p.media_id),
    file = Buffer.from(body.base64, 'base64');
  assert(
    file.length > 0 && file.length <= 5 * 1024 * 1024,
    'INVALID_IMAGE',
    'La fotografía debe ser de máximo 5 MiB.',
    400,
  );
  assert(
    createHash('sha256').update(file).digest('hex') === p.media_hash,
    'INVALID_IMAGE',
    'La fotografía no coincide con la captura firmada.',
    400,
  );
  let metadata;
  try {
    metadata = await sharp(file, { limitInputPixels: 40_000_000 }).metadata();
    await sharp(file, { limitInputPixels: 40_000_000 }).resize({ width: 1 }).toBuffer();
  } catch {
    throw Object.assign(Error('Archivo de imagen inválido.'), {
      code: 'INVALID_IMAGE',
      status: 400,
    });
  }
  assert(
    ['jpeg', 'png', 'webp'].includes(metadata.format || ''),
    'INVALID_IMAGE',
    'Usa JPG, PNG o WebP.',
    400,
  );
  const contentType = `image/${metadata.format}`,
    path = `branches/${c.branch_id}/tasks/${p.id}/${id}`;
  await transaction(c.branch_id, async (db) => {
    assert(
      (
        await db.query('SELECT id FROM tasks WHERE id=$1 AND user_id=$2', [
          z.uuid().parse(p.id),
          c.actor_user_id,
        ])
      ).rowCount,
      'NOT_FOUND',
      'Tarea no encontrada.',
      404,
    );
    const existing = (await db.query('SELECT * FROM media_objects WHERE id=$1', [id])).rows[0];
    if (existing) {
      assert(
        existing.sha256 === p.media_hash,
        'VERSION_CONFLICT',
        'UUID de fotografía reutilizado.',
      );
      return;
    }
    if (cloud)
      await cloud.file(path).save(file, {
        resumable: false,
        validation: 'crc32c',
        contentType,
        metadata: { cacheControl: 'private, no-store' },
      });
    else {
      await mkdir(`${localDir}/${c.branch_id}`, { recursive: true });
      await writeFile(`${localDir}/${c.branch_id}/${id}`, file, { flag: 'wx' }).catch(
        async (err) => {
          if (err.code !== 'EEXIST') throw err;
          const prior = await readFile(`${localDir}/${c.branch_id}/${id}`);
          assert(
            createHash('sha256').update(prior).digest('hex') === p.media_hash,
            'VERSION_CONFLICT',
            'Archivo local distinto.',
          );
        },
      );
    }
    await db.query('INSERT INTO media_objects VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
      c.branch_id,
      id,
      p.id,
      c.actor_user_id,
      p.media_hash,
      file.length,
      contentType,
      path,
    ]);
  });
  res.json({ media_id: id, status: 'confirmed' });
});
media.get('/:id/content', async (req, res) => {
  const user = await identity(req.headers.authorization),
    b = await context(user, req.query.branch_id as string);
  const object = await transaction(b.id, async (db) => {
    const row = (
      await db.query(
        'SELECT m.*,t.user_id FROM media_objects m JOIN tasks t ON t.branch_id=m.branch_id AND t.id=m.task_id WHERE m.id=$1',
        [z.uuid().parse(req.params.id)],
      )
    ).rows[0];
    assert(
      row && (user.role !== 'employee' || row.user_id === user.id),
      'NOT_FOUND',
      'Evidencia no encontrada.',
      404,
    );
    return row;
  });
  const file = cloud
    ? (await cloud.file(object.object_path).download())[0]
    : await readFile(`${localDir}/${b.id}/${object.id}`);
  res.setHeader('Content-Type', object.content_type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file);
});
