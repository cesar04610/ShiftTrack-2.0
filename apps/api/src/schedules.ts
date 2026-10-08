import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { admin, context, transaction } from './db.js';
import { identity } from './security.js';
import { assert } from '../../../packages/domain/index.js';
export const schedules = express.Router();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const fields = z
  .object({
    user_id: z.uuid(),
    business_date: z.iso.date(),
    start_time: time,
    end_time: time,
  })
  .refine((p) => p.end_time > p.start_time, {
    message: 'La salida debe ser posterior a la entrada.',
  });
export const boardTimes = {
  morning: { full: ['07:30', '15:00'], half: ['12:00', '15:00'] },
  afternoon: { full: ['15:00', '21:30'], half: ['18:30', '21:30'] },
} as const;
schedules.post('/', async (req, res) => {
  const actor = await identity(req.headers.authorization);
  admin(actor);
  const branch = await context(actor, req.body.branch_id);
  const p = fields.parse(req.body);
  const result = await save(branch.id, actor.id, p);
  res.status(201).json(result);
});
schedules.post('/board', async (req, res) => {
  const actor = await identity(req.headers.authorization);
  admin(actor);
  const branch = await context(actor, req.body.branch_id);
  const p = z
    .object({
      id: z.uuid().optional(),
      user_id: z.uuid(),
      business_date: z.iso.date(),
      shift: z.enum(['morning', 'afternoon']),
      half: z.boolean().default(false),
      // Zero-based place inside the day and shift; omitted keeps the current place or appends.
      index: z.number().int().min(0).max(100).optional(),
    })
    .parse(req.body);
  const [start_time, end_time] = boardTimes[p.shift][p.half ? 'half' : 'full'];
  res.json(await save(branch.id, actor.id, { ...p, start_time, end_time }, p.id, p.index));
});
schedules.post('/board/delete', async (req, res) => {
  const actor = await identity(req.headers.authorization);
  admin(actor);
  const branch = await context(actor, req.body.branch_id);
  const p = z.object({ id: z.uuid() }).parse(req.body);
  res.json(
    await transaction(branch.id, async (db) => {
      await db.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [branch.id]);
      const existing = (await db.query('SELECT * FROM schedules WHERE id=$1', [p.id])).rows[0];
      assert(existing, 'NOT_FOUND', 'El horario ya no está disponible.', 404);
      assert(
        !(await db.query('SELECT 1 FROM cuts WHERE schedule_id=$1 LIMIT 1', [p.id])).rowCount,
        'SCHEDULE_IN_USE',
        'Este turno ya tiene un corte registrado y no se puede quitar.',
        409,
      );
      await db.query('DELETE FROM schedules WHERE id=$1', [p.id]);
      await db.query('INSERT INTO audit_events VALUES($1,$2,$3,$4,$5,now())', [
        branch.id,
        randomUUID(),
        actor.id,
        'schedule.delete',
        { id: p.id, user_id: existing.user_id, business_date: existing.business_date },
      ]);
      return { id: p.id, ok: true };
    }),
  );
});
async function save(
  branch: string,
  actor: string,
  p: z.infer<typeof fields>,
  id?: string,
  index?: number,
) {
  return transaction(branch, async (db) => {
    // Serialize assignments per branch so simultaneous drags cannot create overlapping shifts.
    await db.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [branch]);
    assert(
      (
        await db.query(
          "SELECT id FROM users WHERE id=$1 AND active AND (branch_id=$2 OR role='superadmin')",
          [p.user_id, branch],
        )
      ).rowCount,
      'NOT_FOUND',
      'La persona no está disponible en esta sucursal.',
      404,
    );
    if (id) {
      const existing = (await db.query('SELECT * FROM schedules WHERE id=$1', [id])).rows[0];
      assert(existing, 'NOT_FOUND', 'El horario ya no está disponible.', 404);
      assert(
        existing.user_id === p.user_id,
        'INVALID_SCHEDULE',
        'La ficha debe corresponder a la misma persona.',
        400,
      );
    }
    const conflict = (
      await db.query(
        `SELECT * FROM schedules WHERE user_id=$1 AND business_date=$2
      AND start_time<$4::time AND end_time>$3::time AND ($5::uuid IS NULL OR id<>$5)`,
        [p.user_id, p.business_date, p.start_time, p.end_time, id || null],
      )
    ).rows[0];
    if (
      !id &&
      conflict &&
      conflict.start_time.slice(0, 5) === p.start_time &&
      conflict.end_time.slice(0, 5) === p.end_time
    )
      return { id: conflict.id, ok: true };
    assert(
      !conflict,
      'SCHEDULE_OVERLAP',
      'Esta persona ya tiene un horario que se cruza con ese turno. Selecciona su ficha para cambiarlo.',
      409,
    );
    const scheduleId = id || randomUUID();
    if (id)
      await db.query(
        'UPDATE schedules SET business_date=$2,start_time=$3,end_time=$4 WHERE id=$1',
        [id, p.business_date, p.start_time, p.end_time],
      );
    else
      await db.query('INSERT INTO schedules VALUES($1,$2,$3,$4,$5,$6)', [
        branch,
        scheduleId,
        p.user_id,
        p.business_date,
        p.start_time,
        p.end_time,
      ]);
    await place(db, branch, scheduleId, p, id ? index : (index ?? Infinity), !id);
    await db.query('INSERT INTO audit_events VALUES($1,$2,$3,$4,$5,now())', [
      branch,
      randomUUID(),
      actor,
      id ? 'schedule.update' : 'schedule.create',
      { id: scheduleId, ...p },
    ]);
    return { id: scheduleId, ok: true };
  });
}

let hasPosition: boolean | undefined;
// Renumbers the day and shift of the saved turn so the administrator's order persists.
async function place(
  db: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> },
  branch: string,
  id: string,
  p: { business_date: string; start_time: string },
  index: number | undefined,
  created: boolean,
) {
  hasPosition ??= !!(
    await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='schedules' AND column_name='position'",
    )
  ).rows.length;
  // Deployments that have not applied migration 009 keep working without custom order.
  if (!hasPosition) return;
  const morning = p.start_time < '15:00';
  const ids: string[] = (
    await db.query(
      `SELECT id FROM schedules WHERE branch_id=$1 AND business_date=$2 AND (start_time<time '15:00')=$3 AND id<>$4
       ORDER BY position, start_time, id`,
      [branch, p.business_date, morning, id],
    )
  ).rows.map((r) => r.id);
  // An edit without an index (full/half change) stays where it was only if it did not change slot.
  if (index === undefined) {
    const prior = (await db.query('SELECT position FROM schedules WHERE id=$1', [id])).rows[0];
    index = created || !prior ? ids.length : Math.min(prior.position, ids.length);
  }
  ids.splice(Math.min(index, ids.length), 0, id);
  for (const [position, row] of ids.entries())
    await db.query('UPDATE schedules SET position=$2 WHERE id=$1', [row, position]);
}
