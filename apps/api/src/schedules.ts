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
    })
    .parse(req.body);
  const [start_time, end_time] = boardTimes[p.shift][p.half ? 'half' : 'full'];
  res.json(await save(branch.id, actor.id, { ...p, start_time, end_time }, p.id));
});
async function save(branch: string, actor: string, p: z.infer<typeof fields>, id?: string) {
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
