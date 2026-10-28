import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { localTime, money, shiftBusinessDate, shiftLabel } from '../../../packages/domain/index.js';

// Store alerts shown to the owner. Thresholds live here so they are easy to change.
export const LATE_MINUTES = 20;
export const EARLY_EXIT_MINUTES = 10;
export const CUT_DIFFERENCE_CENTS = 2500n;
export const SUPPLIER_DIFFERENCE_CENTS = 10000n;
const MIN_SHIFT_MINUTES_EARLY_EXIT = 30;
const MIN_SHIFT_MINUTES_CUT = 60;
// A sign-in right after a sign-out continues the same shift, so exits are judged after this pause.
const SETTLE_MINUTES = 20;
// Only recent days are judged, so a deployment never floods the owner with old history.
const LOOKBACK_DAYS = 3;
const TASK_LOOKBACK_DAYS = 7;

export type AlertKind =
  | 'late'
  | 'absent'
  | 'early_exit'
  | 'cut_difference'
  | 'missing_cut'
  | 'task_incomplete'
  | 'supplier_difference';
type Alert = {
  kind: AlertKind;
  key: string;
  userId?: string | null;
  date?: string | null;
  message: string;
  amountCents?: bigint | string | null;
  at?: Date | string;
};
type Db = Pick<pg.PoolClient, 'query'>;

let tableReady = false;
// Deployments that have not applied the alert migration yet keep working without alerts.
export async function alertsReady(db: Db) {
  if (tableReady) return true;
  tableReady = !!(await db.query("SELECT to_regclass('public.alert_log') AS t")).rows[0].t;
  return tableReady;
}
export async function raise(db: Db, branch: string, a: Alert) {
  if (!(await alertsReady(db))) return 0;
  return (
    (
      await db.query(
        `INSERT INTO alert_log(branch_id,id,kind,user_id,business_date,message,amount_cents,source_key,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now())) ON CONFLICT(branch_id,source_key) DO NOTHING`,
        [
          branch,
          randomUUID(),
          a.kind,
          a.userId ?? null,
          a.date ?? null,
          a.message,
          a.amountCents == null ? null : a.amountCents.toString(),
          a.key,
          a.at ?? null,
        ],
      )
    ).rowCount || 0
  );
}
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const hhmm = (total: number) =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
const short = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const day = (value: Date | string) =>
  typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);

// Judged from the stored records, so running it again never repeats an alert.
export async function evaluateAlerts(
  db: Db,
  branch: { id: string; timezone: string },
  now = new Date(),
) {
  if (!(await alertsReady(db))) return 0;
  const zone = branch.timezone;
  let raised = 0;
  const today = localTime(now, zone).date;
  const records = (
    await db.query(
      `SELECT c.*,u.name FROM clock_records c JOIN users u ON u.id=c.user_id
       WHERE c.clock_in>$1::timestamptz-make_interval(days=>$2) ORDER BY c.clock_in`,
      [now, LOOKBACK_DAYS],
    )
  ).rows;
  for (const rec of records) {
    const arrival = localTime(rec.clock_in, zone);
    const schedule = (
      await db.query(
        'SELECT * FROM schedules WHERE user_id=$1 AND business_date=$2 ORDER BY abs(extract(epoch FROM (start_time-$3::time))) LIMIT 1',
        [rec.user_id, arrival.date, hhmm(arrival.minutes)],
      )
    ).rows[0];
    // People without a schedule that day (for example an administrator) are never judged.
    if (!schedule) continue;
    const start = minutes(schedule.start_time),
      end = minutes(schedule.end_time);
    const earlier = records.some(
      (o) =>
        o.user_id === rec.user_id &&
        o.id !== rec.id &&
        +o.clock_in < +rec.clock_in &&
        localTime(o.clock_in, zone).date === arrival.date &&
        localTime(o.clock_in, zone).minutes >= start - 120,
    );
    if (!earlier && arrival.minutes > start + LATE_MINUTES && arrival.minutes < end)
      raised += await raise(db, branch.id, {
        kind: 'late',
        key: `late:${rec.id}`,
        userId: rec.user_id,
        date: arrival.date,
        at: rec.clock_in,
        message: `${rec.name} llegó tarde: ${arrival.minutes - start} min (entrada ${hhmm(arrival.minutes)}, horario ${hhmm(start)}).`,
      });
    if (!rec.clock_out || +now - +rec.clock_out < SETTLE_MINUTES * 60_000) continue;
    const worked = Math.round((+rec.clock_out - +rec.clock_in) / 60_000);
    const leaving = localTime(rec.clock_out, zone);
    if (
      worked >= MIN_SHIFT_MINUTES_EARLY_EXIT &&
      leaving.date === arrival.date &&
      leaving.minutes < end - EARLY_EXIT_MINUTES
    )
      raised += await raise(db, branch.id, {
        kind: 'early_exit',
        key: `early:${rec.id}`,
        userId: rec.user_id,
        date: arrival.date,
        at: rec.clock_out,
        message: `${rec.name} salió antes de tiempo: ${end - leaving.minutes} min antes (salida ${hhmm(leaving.minutes)}, horario hasta ${hhmm(end)}).`,
      });
    if (worked >= MIN_SHIFT_MINUTES_CUT) {
      const shiftDate = shiftBusinessDate(rec.clock_in, zone),
        label = shiftLabel(rec.clock_in, zone);
      const hasCut = (
        await db.query(
          'SELECT 1 FROM cuts WHERE user_id=$1 AND (clock_record_id=$2 OR (business_date=$3 AND label=$4)) LIMIT 1',
          [rec.user_id, rec.id, shiftDate, label],
        )
      ).rowCount;
      if (!hasCut)
        raised += await raise(db, branch.id, {
          kind: 'missing_cut',
          key: `nocut:${rec.user_id}:${shiftDate}:${label}`,
          userId: rec.user_id,
          date: shiftDate,
          at: rec.clock_out,
          message: `${rec.name} trabajó su turno de ${label.toLowerCase()} y no hizo corte.`,
        });
    }
  }
  const absences = (
    await db.query(
      `SELECT s.*,u.name,((s.business_date+s.end_time) AT TIME ZONE $2) AS ended_at
       FROM schedules s JOIN users u ON u.id=s.user_id
       WHERE u.active AND u.deleted_at IS NULL
         AND s.business_date BETWEEN $1::date-$3::integer AND $1::date
         AND ((s.business_date+s.end_time) AT TIME ZONE $2)<$4::timestamptz
         AND NOT EXISTS(SELECT 1 FROM clock_records c WHERE c.user_id=s.user_id
           AND c.clock_in>=((s.business_date+s.start_time) AT TIME ZONE $2)-interval '2 hours'
           AND c.clock_in<((s.business_date+s.end_time) AT TIME ZONE $2))`,
      [today, zone, LOOKBACK_DAYS, now],
    )
  ).rows;
  for (const s of absences)
    raised += await raise(db, branch.id, {
      kind: 'absent',
      key: `absent:${s.id}`,
      userId: s.user_id,
      date: day(s.business_date),
      at: s.ended_at,
      message: `${s.name} faltó el ${short(day(s.business_date))}: no registró entrada en su horario (${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}).`,
    });
  // A task is missed once its work day ends at 05:00 the next morning.
  const workDay = shiftBusinessDate(now, zone);
  const tasks = (
    await db.query(
      `SELECT t.*,u.name,((t.due_date+1)+time '05:00') AT TIME ZONE $3 AS overdue_at
       FROM tasks t JOIN users u ON u.id=t.user_id
       WHERE t.completed_at IS NULL AND t.due_date<$1::date AND t.due_date>=$1::date-$2::integer`,
      [workDay, TASK_LOOKBACK_DAYS, zone],
    )
  ).rows;
  for (const t of tasks)
    raised += await raise(db, branch.id, {
      kind: 'task_incomplete',
      key: `task:${t.id}`,
      userId: t.user_id,
      date: day(t.due_date),
      at: t.overdue_at,
      message: `${t.name} no realizó la tarea «${t.title}» del ${short(day(t.due_date))}.`,
    });
  return raised;
}

export async function cutDifferenceAlert(
  db: Db,
  branch: string,
  cut: { id: string; userId: string; date: string; label: string; difference: string; at: string },
) {
  const difference = BigInt(cut.difference);
  if ((difference < 0n ? -difference : difference) <= CUT_DIFFERENCE_CENTS) return;
  const name = (await db.query('SELECT name FROM users WHERE id=$1', [cut.userId])).rows[0]?.name;
  await raise(db, branch, {
    kind: 'cut_difference',
    key: `cutdiff:${cut.id}`,
    userId: cut.userId,
    date: cut.date,
    at: cut.at,
    amountCents: difference,
    message: `${name || 'Un empleado'} tiene ${difference < 0n ? 'faltante' : 'sobrante'} de ${money(difference < 0n ? -difference : difference)} en su corte de ${cut.label.toLowerCase()} (${short(cut.date)}).`,
  });
}
export async function supplierDifferenceAlert(
  db: Db,
  branch: string,
  shift: {
    id: string;
    userId: string;
    date: string;
    expected: bigint;
    counted: bigint;
    at: string;
  },
) {
  const difference = shift.counted - shift.expected;
  if ((difference < 0n ? -difference : difference) <= SUPPLIER_DIFFERENCE_CENTS) return;
  const name = (await db.query('SELECT name FROM users WHERE id=$1', [shift.userId])).rows[0]?.name;
  await raise(db, branch, {
    kind: 'supplier_difference',
    key: `supplier:${shift.id}`,
    userId: shift.userId,
    date: shift.date,
    at: shift.at,
    amountCents: difference,
    message: `Cierre de caja de proveedores con ${difference < 0n ? 'faltante' : 'sobrante'} de ${money(difference < 0n ? -difference : difference)} (esperado ${money(shift.expected)}, contado ${money(shift.counted)}). Responsable: ${name || 'sin nombre'}.`,
  });
}
