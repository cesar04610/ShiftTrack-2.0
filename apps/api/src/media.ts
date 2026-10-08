import express from 'express';
import sharp from 'sharp';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { deviceIdentity, validateCommand, identity } from './security.js';
import { context, hasColumn, pool, transaction } from './db.js';
import { commandSchema } from './commands.js';
import { assert } from '../../../packages/domain/index.js';
import { mediaDir as localDir } from './storage.js';
export const media = express.Router();
media.use(express.json({ limit: '8mb' }));
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
    {
      await mkdir(`${localDir}/${c.branch_id}`, { recursive: true, mode: 0o700 });
      await writeFile(`${localDir}/${c.branch_id}/${id}`, file, { flag: 'wx', mode: 0o600 }).catch(
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
    b = await context(user, req.query.branch_id as string, true);
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
  assert(
    !object.deleted_at,
    'EVIDENCE_EXPIRED',
    'La fotografía se eliminó automáticamente después de 30 días.',
    410,
  );
  const file = await readFile(`${localDir}/${b.id}/${object.id}`);
  res.setHeader('Content-Type', object.content_type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file);
});

export const MEDIA_RETENTION_DAYS = 30;
// Evidence photos live in the API volume, so the API process removes them once they expire.
export async function purgeExpiredMedia() {
  if (!(await hasColumn(pool, 'media_objects', 'deleted_at'))) return 0;
  let removed = 0;
  for (const branch of (await pool.query('SELECT id FROM branches')).rows) {
    await transaction(branch.id, async (db) => {
      const expired = (
        await db.query(
          `SELECT id FROM media_objects WHERE deleted_at IS NULL AND created_at < now() - make_interval(days => $1)`,
          [MEDIA_RETENTION_DAYS],
        )
      ).rows;
      for (const { id } of expired) {
        await unlink(`${localDir}/${branch.id}/${id}`).catch((err) => {
          if (err.code !== 'ENOENT') throw err;
        });
        await db.query('UPDATE media_objects SET deleted_at=now() WHERE id=$1', [id]);
        removed += 1;
      }
    });
  }
  return removed;
}
