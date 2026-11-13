import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { admin, context, hasColumn, transaction } from './db.js';
import { identity } from './security.js';
import { writeAudit } from './audit-detail.js';
import {
  assert,
  localTime,
  shiftBusinessDate,
  shiftLabel,
} from '../../../packages/domain/index.js';

// Tasks are no longer assigned person by person: every register and shift (full or half) has its
// own list, and whoever works that shift at that register receives it automatically.
export const taskSetup = express.Router();
type Branch = { id: string; timezone: string; register_count?: number };
type Config = { shift: 'morning' | 'afternoon'; half: boolean; register_number: number };

const config = z.object({
  shift: z.enum(['morning', 'afternoon']),
  half: z.boolean(),
  register_number: z.number().int().min(1).max(100),
});
const title = z.string().trim().min(1).max(200);
const weekdays = z
  .array(z.number().int().min(0).max(6))
  .min(1, 'Elige al menos un día.')
  .max(7)
  .transform((days) => [...new Set(days)].sort());
const everyDay = [0, 1, 2, 3, 4, 5, 6];
// A schedule counts from two hours before its start, so arriving early already gets its tasks.
const EARLY_MINUTES = 120;
// Half shifts last 3 hours; full ones 6.5 or more.
const HALF_MAX_MINUTES = 240;
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export const setupReady = (db: Pick<pg.PoolClient, 'query'>) =>
  hasColumn(db, 'tasks', 'setup_item_id');

// Which shift a person is working right now: their schedule decides; without one, their entry.
async function currentShift(
  db: pg.PoolClient,
  branch: Branch,
  userId: string,
  day: string,
  now: Date,
): Promise<{ shift: Config['shift']; half: boolean }> {
  const local = localTime(now, branch.timezone);
  // After midnight the work day continues, so the clock keeps counting past 24:00.
  const minute = local.date === day ? local.minutes : local.minutes + 1440;
  const turns = (
    await db.query(
      'SELECT start_time::text AS start,end_time::text AS end FROM schedules WHERE user_id=$1 AND business_date=$2',
      [userId, day],
    )
  ).rows
    .map((r) => ({ start: minutesOf(r.start), end: minutesOf(r.end) }))
    .filter((t) => t.start - EARLY_MINUTES <= minute)
    .sort((a, b) => a.start - b.start);
  // The turn in progress wins; otherwise the latest one that already counts (early or overtime).
  const turn = turns.find((t) => t.start <= minute && minute < t.end) ?? turns.at(-1);
  if (turn)
    return {
      shift: turn.start < 900 ? 'morning' : 'afternoon',
      half: turn.end - turn.start <= HALF_MAX_MINUTES,
    };
  const entry = (
    await db.query(
      'SELECT clock_in FROM clock_records WHERE user_id=$1 AND clock_out IS NULL AND business_date=$2 ORDER BY clock_in DESC LIMIT 1',
      [userId, day],
    )
  ).rows[0];
  return {
    shift:
      shiftLabel(entry?.clock_in ?? now, branch.timezone) === 'Mañana' ? 'morning' : 'afternoon',
    half: false,
  };
}

// Gives a person the tasks of the register and shift they are working. Safe to repeat: it only
// adds what is missing. Pending tasks of another register or shift length in the same shift are
// replaced (wrong register picked, schedule corrected); done ones and evidence always stay.
export async function assignSetupTasks(
  db: pg.PoolClient,
  branch: Branch,
  userId: string,
  registerNumber: number,
  now = new Date(),
) {
  if (!(await setupReady(db))) return 0;
  const day = shiftBusinessDate(now, branch.timezone);
  const { shift, half } = await currentShift(db, branch, userId, day, now);
  await db.query(
    `DELETE FROM tasks t WHERE t.user_id=$1 AND t.due_date=$2 AND t.setup_item_id IS NOT NULL AND t.shift=$3
     AND t.completed_at IS NULL AND (t.half<>$4 OR t.register_number<>$5)
     AND NOT EXISTS(SELECT 1 FROM media_objects m WHERE m.task_id=t.id)`,
    [userId, day, shift, half, registerNumber],
  );
  return (
    (
      await db.query(
        `INSERT INTO tasks(branch_id,id,user_id,title,due_date,setup_item_id,shift,half,register_number)
         SELECT i.branch_id,gen_random_uuid(),$2,i.title,$3::date,i.id,i.shift,i.half,i.register_number
         FROM task_setup_items i
         WHERE i.branch_id=$1 AND i.active AND i.shift=$4 AND i.half=$5 AND i.register_number=$6
           AND extract(dow FROM $3::date)::integer=ANY(i.weekdays)
         ON CONFLICT(branch_id,setup_item_id,user_id,due_date) WHERE setup_item_id IS NOT NULL DO NOTHING`,
        [branch.id, userId, day, shift, half, registerNumber],
      )
    ).rowCount || 0
  );
}

// Keeps everyone who is working right now up to date: a list edited mid-shift, or a double shift
// that passes from morning to afternoon without signing in again.
export async function assignWorkingStaff(db: pg.PoolClient, branch: Branch, now = new Date()) {
  if (!(await setupReady(db))) return 0;
  const day = shiftBusinessDate(now, branch.timezone);
  // Only people with a live session and an open entry of today; a forgotten session gets nothing.
  const working = (
    await db.query(
      `SELECT l.user_id,l.register_number FROM register_leases l
       JOIN auth_sessions s ON s.token_hash=l.session_hash AND (s.expires_at IS NULL OR s.expires_at>now())
       WHERE EXISTS(SELECT 1 FROM clock_records c WHERE c.user_id=l.user_id AND c.clock_out IS NULL AND c.business_date=$1)`,
      [day],
    )
  ).rows;
  let created = 0;
  for (const w of working)
    created += await assignSetupTasks(db, branch, w.user_id, w.register_number, now);
  return created;
}

async function member(db: pg.PoolClient, branch: string, id: string) {
  assert(
    (
      await db.query(
        "SELECT id FROM users WHERE id=$1 AND (branch_id=$2 OR role='superadmin') AND active",
        [id, branch],
      )
    ).rowCount,
    'NOT_FOUND',
    'Persona no disponible en la sucursal.',
    404,
  );
}
function inBranch(branch: Branch, c: Config) {
  assert(
    c.register_number <= (branch.register_count ?? 100),
    'INVALID_REGISTER',
    'Elige una de las cajas configuradas en la sucursal.',
    400,
  );
}

// Puts a task on the given days of a list. A task with the same name already in that list only
// gains the days it lacks, so a rename or removal later covers every day at once.
async function addToDay(
  db: pg.PoolClient,
  branch: string,
  c: Config,
  name: string,
  days: number[],
) {
  const existing = (
    await db.query(
      `SELECT id,weekdays FROM task_setup_items WHERE active AND shift=$1 AND half=$2 AND register_number=$3
       AND lower(title)=lower($4) ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
      [c.shift, c.half, c.register_number, name],
    )
  ).rows[0];
  if (!existing) {
    await db.query(
      'INSERT INTO task_setup_items(branch_id,id,shift,half,register_number,title,weekdays,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())',
      [branch, randomUUID(), c.shift, c.half, c.register_number, name, days],
    );
    return 1;
  }
  const merged = [...new Set([...existing.weekdays, ...days])].sort();
  if (merged.length === existing.weekdays.length) return 0;
  await db.query('UPDATE task_setup_items SET weekdays=$2 WHERE id=$1', [existing.id, merged]);
  return 1;
}

// Extraordinary task: one person, one day, outside the lists.
taskSetup.post('/', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = z
    .object({
      user_id: z.uuid(),
      title,
      due_date: z.iso.date(),
      priority: z.enum(['normal', 'alta']).default('normal'),
    })
    .parse(req.body);
  assert(
    p.due_date >= shiftBusinessDate(new Date(), b.timezone),
    'INVALID_DATE',
    'La tarea debe ser para hoy o un día próximo.',
    400,
  );
  const id = randomUUID();
  await transaction(b.id, async (db) => {
    await member(db, b.id, p.user_id);
    await db.query(
      'INSERT INTO tasks(branch_id,id,user_id,title,due_date,priority) VALUES($1,$2,$3,$4,$5,$6)',
      [b.id, id, p.user_id, p.title, p.due_date, p.priority],
    );
    await writeAudit(db, b.id, user.id, 'task.create', {
      id,
      user_id: p.user_id,
      title: p.title,
      due_date: p.due_date,
    });
  });
  res.status(201).json({ ok: true, id });
});

taskSetup.post('/setup', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = config.extend({ title, weekdays: weekdays.default(everyDay) }).parse(req.body);
  inBranch(b, p);
  await transaction(b.id, async (db) => {
    await addToDay(db, b.id, p, p.title, p.weekdays);
    await writeAudit(db, b.id, user.id, 'task.setup.create', { ...p });
    await assignWorkingStaff(db, b);
  });
  res.status(201).json({ ok: true });
});

// Copies the list of one day, register and shift into another. A task the destination already has
// on other days only gains the new day; nothing is duplicated.
taskSetup.post('/setup/copy', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const dayConfig = config.extend({ weekday: z.number().int().min(0).max(6) });
  const p = z.object({ from: dayConfig, to: dayConfig }).parse(req.body);
  inBranch(b, p.from);
  inBranch(b, p.to);
  const count = await transaction(b.id, async (db) => {
    const source = (
      await db.query(
        `SELECT title FROM task_setup_items WHERE active AND shift=$1 AND half=$2 AND register_number=$3
         AND $4::integer=ANY(weekdays) ORDER BY created_at,id`,
        [p.from.shift, p.from.half, p.from.register_number, p.from.weekday],
      )
    ).rows;
    let copied = 0;
    for (const item of source) copied += await addToDay(db, b.id, p.to, item.title, [p.to.weekday]);
    await writeAudit(db, b.id, user.id, 'task.setup.copy', { ...p, copied });
    await assignWorkingStaff(db, b);
    return copied;
  });
  res.json({ ok: true, count });
});

taskSetup.post('/setup/:id', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const id = z.uuid().parse(req.params.id);
  const p = z.object({ title, weekdays }).parse(req.body);
  await transaction(b.id, async (db) => {
    assert(
      (
        await db.query(
          'UPDATE task_setup_items SET title=$2,weekdays=$3 WHERE id=$1 AND active RETURNING id',
          [id, p.title, p.weekdays],
        )
      ).rowCount,
      'NOT_FOUND',
      'La tarea ya no está en la lista.',
      404,
    );
    // Today's pending copies follow the change; finished ones and past days stay as they were.
    const day = shiftBusinessDate(new Date(), b.timezone);
    await db.query(
      'UPDATE tasks SET title=$2 WHERE setup_item_id=$1 AND due_date=$3 AND completed_at IS NULL',
      [id, p.title, day],
    );
    await db.query(
      `DELETE FROM tasks t WHERE t.setup_item_id=$1 AND t.due_date=$2 AND t.completed_at IS NULL
       AND NOT extract(dow FROM $2::date)::integer=ANY($3::integer[])
       AND NOT EXISTS(SELECT 1 FROM media_objects m WHERE m.task_id=t.id)`,
      [id, day, p.weekdays],
    );
    await writeAudit(db, b.id, user.id, 'task.setup.update', { id, ...p });
    await assignWorkingStaff(db, b);
  });
  res.json({ ok: true });
});

taskSetup.post('/setup/:id/delete', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const id = z.uuid().parse(req.params.id);
  await transaction(b.id, async (db) => {
    const item = (
      await db.query(
        'UPDATE task_setup_items SET active=false WHERE id=$1 AND active RETURNING title',
        [id],
      )
    ).rows[0];
    assert(item, 'NOT_FOUND', 'La tarea ya no está en la lista.', 404);
    await db.query(
      `DELETE FROM tasks t WHERE t.setup_item_id=$1 AND t.due_date=$2 AND t.completed_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM media_objects m WHERE m.task_id=t.id)`,
      [id, shiftBusinessDate(new Date(), b.timezone)],
    );
    await writeAudit(db, b.id, user.id, 'task.setup.delete', { id, title: item.title });
  });
  res.json({ ok: true });
});

taskSetup.post('/:id/revert', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const id = z.uuid().parse(req.params.id);
  await transaction(b.id, async (db) => {
    assert(
      (await db.query('UPDATE tasks SET completed_at=NULL WHERE id=$1 RETURNING id', [id]))
        .rowCount,
      'NOT_FOUND',
      'Tarea no encontrada.',
      404,
    );
    await writeAudit(db, b.id, user.id, 'task.revert', { id });
  });
  res.json({ ok: true });
});

// Only an extraordinary task that nobody has done can be removed; the lists are edited above.
taskSetup.post('/:id/delete', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const id = z.uuid().parse(req.params.id);
  await transaction(b.id, async (db) => {
    const task = (
      await db.query(
        `DELETE FROM tasks t WHERE t.id=$1 AND t.setup_item_id IS NULL AND t.assignment_id IS NULL
         AND t.completed_at IS NULL AND t.due_date>=$2
         AND NOT EXISTS(SELECT 1 FROM media_objects m WHERE m.task_id=t.id)
         RETURNING t.title,t.user_id,t.due_date::text AS due_date`,
        [id, shiftBusinessDate(new Date(), b.timezone)],
      )
    ).rows[0];
    assert(
      task,
      'TASK_FIXED',
      'Solo se puede quitar una tarea extra pendiente de hoy o de un día próximo.',
      409,
    );
    await writeAudit(db, b.id, user.id, 'task.delete', { id, ...task });
  });
  res.json({ ok: true });
});
