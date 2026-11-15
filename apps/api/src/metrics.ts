import express from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { identity } from './security.js';
import { admin, context, transaction } from './db.js';
import { alertsReady } from './alerts.js';
import { assert, shiftBusinessDate } from '../../../packages/domain/index.js';

// Métricas: tendencias y comparaciones de una sucursal. Reportes lista cada registro;
// aquí cada cifra se compara con el periodo anterior de la misma duración.
export const metrics = express.Router();

const range = z.object({
  branch_id: z.string().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
});
const MAX_DAYS = 400;
const DAY = 86_400_000;
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

// The period right before the chosen one, with the same number of days.
export function previousPeriod(from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  return { from: shift(from, -days), to: shift(from, -1) };
}

async function load(req: express.Request) {
  const user = await identity(req.headers.authorization);
  admin(user);
  const q = range.parse(req.query);
  assert(q.from <= q.to, 'INVALID_RANGE', 'La fecha inicial debe ser anterior a la final.', 400);
  assert(
    (Date.parse(q.to) - Date.parse(q.from)) / DAY <= MAX_DAYS,
    'INVALID_RANGE',
    'El rango máximo es de 400 días.',
    400,
  );
  const b = await context(user, q.branch_id, true);
  return { b, from: q.from, to: q.to };
}

// One connection runs one query at a time.
async function serial<T>(queries: (() => Promise<T>)[]) {
  const out: T[] = [];
  for (const q of queries) out.push(await q());
  return out;
}

// Sales come from the cuts, dated by their work day (05:00 to 05:00), as in Reportes.
async function sales(db: pg.PoolClient, from: string, to: string) {
  const args = [from, to];
  const [totals, byDay, byShift, byWeekday, byRegister] = await serial([
    () =>
      db.query(
        `SELECT count(*)::int AS cuts,coalesce(sum(sales_cents),0)::text AS sales_cents,
         coalesce(sum(card_cents),0)::text AS card_cents,
         coalesce(sum(sales_cents-card_cents),0)::text AS cash_cents,
         count(DISTINCT business_date)::int AS days
       FROM cuts WHERE business_date BETWEEN $1 AND $2`,
        args,
      ),
    () =>
      db.query(
        `SELECT business_date::text AS date,count(*)::int AS cuts,sum(sales_cents)::text AS sales_cents,
         sum(card_cents)::text AS card_cents
       FROM cuts WHERE business_date BETWEEN $1 AND $2 GROUP BY business_date ORDER BY business_date`,
        args,
      ),
    () =>
      db.query(
        `SELECT label,count(*)::int AS cuts,sum(sales_cents)::text AS sales_cents,
         count(DISTINCT business_date)::int AS days
       FROM cuts WHERE business_date BETWEEN $1 AND $2 GROUP BY label ORDER BY label`,
        args,
      ),
    // Average of the days that had cuts: days before the store used the app don't drag it down.
    () =>
      db.query(
        `SELECT extract(isodow FROM business_date)::int AS weekday,count(DISTINCT business_date)::int AS days,
         sum(sales_cents)::text AS sales_cents
       FROM cuts WHERE business_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`,
        args,
      ),
    () =>
      db.query(
        `SELECT register_number,count(*)::int AS cuts,sum(sales_cents)::text AS sales_cents
       FROM cuts WHERE business_date BETWEEN $1 AND $2 GROUP BY register_number ORDER BY register_number`,
        args,
      ),
  ]);
  return {
    totals: totals.rows[0],
    by_day: byDay.rows,
    by_shift: byShift.rows,
    by_weekday: byWeekday.rows,
    by_register: byRegister.rows,
  };
}

// Purchases are the supplier tickets by local calendar date. Net, like Reportes, is each
// live ticket minus its corrections; voided tickets count apart.
async function purchases(db: pg.PoolClient, zone: string, from: string, to: string) {
  const day = (column: string) => `(${column} AT TIME ZONE $3)::date`;
  const args = [from, to, zone];
  const live = `SELECT t.*,${day('t.occurred_at')} AS date,
      coalesce((SELECT sum(c.amount_cents) FROM supplier_corrections c WHERE c.ticket_id=t.id),0) AS corrected
    FROM tickets t WHERE ${day('t.occurred_at')} BETWEEN $1 AND $2`;
  const [totals, byDay, byWeekday, voids, corrections] = await serial([
    () =>
      db.query(
        `SELECT count(*) FILTER (WHERE NOT voided)::int AS tickets,
         coalesce(sum(amount_cents) FILTER (WHERE NOT voided),0)::text AS gross_cents,
         coalesce(sum(corrected) FILTER (WHERE NOT voided),0)::text AS corrected_cents,
         coalesce(sum(amount_cents-corrected) FILTER (WHERE NOT voided),0)::text AS net_cents,
         count(*) FILTER (WHERE voided)::int AS voided,
         coalesce(sum(amount_cents) FILTER (WHERE voided),0)::text AS voided_cents,
         count(DISTINCT date) FILTER (WHERE NOT voided)::int AS days
       FROM (${live}) t`,
        args,
      ),
    () =>
      db.query(
        `SELECT date::text,count(*)::int AS tickets,sum(amount_cents-corrected)::text AS net_cents
       FROM (${live}) t WHERE NOT voided GROUP BY date ORDER BY date`,
        args,
      ),
    () =>
      db.query(
        `SELECT extract(isodow FROM date)::int AS weekday,count(DISTINCT date)::int AS days,
         sum(amount_cents-corrected)::text AS net_cents
       FROM (${live}) t WHERE NOT voided GROUP BY 1 ORDER BY 1`,
        args,
      ),
    // Only whoever registered a ticket can void it, within five minutes.
    () =>
      db.query(
        `SELECT t.actor_user_id AS user_id,u.name AS employee,count(*)::int AS voided,
         sum(t.amount_cents)::text AS voided_cents
       FROM tickets t JOIN users u ON u.id=t.actor_user_id
       WHERE t.voided AND ${day('t.occurred_at')} BETWEEN $1 AND $2 GROUP BY 1,2`,
        args,
      ),
    // Corrections count on the day they were made.
    () =>
      db.query(
        `SELECT c.actor_user_id AS user_id,u.name AS employee,count(*)::int AS corrections,
         sum(c.amount_cents)::text AS corrections_cents
       FROM supplier_corrections c JOIN users u ON u.id=c.actor_user_id
       WHERE ${day('c.occurred_at')} BETWEEN $1 AND $2 GROUP BY 1,2`,
        args,
      ),
  ]);
  const people = new Map<string, any>();
  for (const r of [...voids.rows, ...corrections.rows]) {
    const p = people.get(r.user_id) || {
      user_id: r.user_id,
      employee: r.employee,
      voided: 0,
      voided_cents: '0',
      corrections: 0,
      corrections_cents: '0',
    };
    people.set(r.user_id, { ...p, ...r });
  }
  const by_person = [...people.values()].sort(
    (a, b) =>
      b.voided + b.corrections - (a.voided + a.corrections) ||
      a.employee.localeCompare(b.employee, 'es'),
  );
  return {
    totals: {
      ...totals.rows[0],
      corrections: by_person.reduce((s, p) => s + p.corrections, 0),
      corrections_cents: by_person.reduce((s, p) => s + BigInt(p.corrections_cents), 0n).toString(),
    },
    by_day: byDay.rows,
    by_weekday: byWeekday.rows,
    by_person,
  };
}

// One line per supplier with live tickets in the period or the one before, with its last
// visit ever (up to the end of the period) to spot those who stopped coming.
async function suppliers(
  db: pg.PoolClient,
  zone: string,
  range: { from: string; to: string },
  previous: { from: string; to: string },
) {
  const day = `(t.occurred_at AT TIME ZONE $5)::date`;
  return (
    await db.query(
      `WITH live AS (
         SELECT t.supplier_id,${day} AS date,
           t.amount_cents-coalesce((SELECT sum(c.amount_cents) FROM supplier_corrections c WHERE c.ticket_id=t.id),0) AS net
         FROM tickets t WHERE NOT t.voided AND ${day} BETWEEN $3 AND $2)
       SELECT s.id,s.company,s.product_type,s.active,
         count(*) FILTER (WHERE l.date>=$1)::int AS tickets,
         count(DISTINCT l.date) FILTER (WHERE l.date>=$1)::int AS days,
         coalesce(sum(l.net) FILTER (WHERE l.date>=$1),0)::text AS net_cents,
         count(*) FILTER (WHERE l.date<=$4)::int AS previous_tickets,
         count(DISTINCT l.date) FILTER (WHERE l.date<=$4)::int AS previous_days,
         coalesce(sum(l.net) FILTER (WHERE l.date<=$4),0)::text AS previous_net_cents,
         (SELECT max(${day})::text FROM tickets t
          WHERE t.supplier_id=s.id AND NOT t.voided AND ${day}<=$2) AS last_visit
       FROM suppliers s JOIN live l ON l.supplier_id=s.id
       GROUP BY s.id,s.company,s.product_type,s.active
       ORDER BY sum(l.net) FILTER (WHERE l.date>=$1) DESC NULLS LAST,s.company`,
      [range.from, range.to, previous.from, previous.to, zone],
    )
  ).rows;
}

// Empleados, with the rules of Reportes and Notificaciones: an absence is a finished schedule
// without an entry from two hours before its start; late arrivals, early exits and shifts
// without a cut come from the alert log; a task is missed once its work day is over.
async function employees(db: pg.PoolClient, zone: string, from: string, to: string) {
  const args = [from, to, zone];
  const alerts = await alertsReady(db);
  const workDay = shiftBusinessDate(new Date(), zone);
  const [schedules, absences, clocks, incidents, tasks, cuts, rates] = await serial([
    // Only schedules that already ended count: today's afternoon shift is not owed yet.
    () =>
      db.query(
        `SELECT s.user_id,count(*)::int AS scheduled,
           coalesce(sum(extract(epoch FROM (s.end_time-s.start_time))/3600),0)::float AS scheduled_hours
         FROM schedules s
         WHERE s.business_date BETWEEN $1 AND $2 AND ((s.business_date+s.end_time) AT TIME ZONE $3)<now()
         GROUP BY s.user_id`,
        args,
      ),
    () =>
      db.query(
        `SELECT s.user_id,count(*)::int AS absences FROM schedules s
         WHERE s.business_date BETWEEN $1 AND $2 AND ((s.business_date+s.end_time) AT TIME ZONE $3)<now()
           AND NOT EXISTS(SELECT 1 FROM clock_records c WHERE c.user_id=s.user_id
             AND c.clock_in>=((s.business_date+s.start_time) AT TIME ZONE $3)-interval '2 hours'
             AND c.clock_in<((s.business_date+s.end_time) AT TIME ZONE $3))
         GROUP BY s.user_id`,
        args,
      ),
    () =>
      db.query(
        `SELECT user_id,count(DISTINCT business_date)::int AS days,
           coalesce(sum(extract(epoch FROM (clock_out-clock_in))/3600) FILTER (WHERE clock_out IS NOT NULL),0)::float AS hours,
           count(*) FILTER (WHERE clock_out IS NULL)::int AS open
         FROM clock_records WHERE business_date BETWEEN $1 AND $2 GROUP BY user_id`,
        args.slice(0, 2),
      ),
    () =>
      alerts
        ? db.query(
            `SELECT user_id,count(*) FILTER (WHERE kind='late')::int AS late,
               count(*) FILTER (WHERE kind='early_exit')::int AS early_exit,
               count(*) FILTER (WHERE kind='missing_cut')::int AS missing_cut
             FROM alert_log WHERE user_id IS NOT NULL AND kind IN ('late','early_exit','missing_cut')
               AND business_date BETWEEN $1 AND $2 GROUP BY user_id`,
            args.slice(0, 2),
          )
        : Promise.resolve({ rows: [] } as any),
    () =>
      db.query(
        `SELECT user_id,count(*)::int AS tasks,count(*) FILTER (WHERE completed_at IS NOT NULL)::int AS tasks_done,
           count(*) FILTER (WHERE completed_at IS NULL AND due_date<$3)::int AS tasks_missed
         FROM tasks WHERE due_date BETWEEN $1 AND $2 GROUP BY user_id`,
        [from, to, workDay],
      ),
    () =>
      db.query(
        `SELECT user_id,count(*)::int AS cuts,count(*) FILTER (WHERE difference_cents<>0)::int AS cuts_uneven,
           sum(difference_cents)::text AS difference_cents,sum(abs(difference_cents))::text AS abs_difference_cents
         FROM cuts WHERE business_date BETWEEN $1 AND $2 GROUP BY user_id`,
        args.slice(0, 2),
      ),
    // Sales per hour: each cut against the hours of the entry it closed, by shift.
    () =>
      db.query(
        `SELECT c.user_id,c.label,sum(c.sales_cents)::text AS sales_cents,
           sum(extract(epoch FROM (r.clock_out-r.clock_in))/3600)::float AS hours
         FROM cuts c JOIN clock_records r ON r.id=c.clock_record_id AND r.clock_out IS NOT NULL
         WHERE c.business_date BETWEEN $1 AND $2 AND r.clock_out>r.clock_in
         GROUP BY c.user_id,c.label`,
        args.slice(0, 2),
      ),
  ]);
  const people = new Map<string, any>();
  const person = (id: string) => {
    if (!people.has(id))
      people.set(id, {
        user_id: id,
        scheduled: 0,
        scheduled_hours: 0,
        absences: 0,
        days: 0,
        hours: 0,
        open: 0,
        late: 0,
        early_exit: 0,
        missing_cut: 0,
        tasks: 0,
        tasks_done: 0,
        tasks_missed: 0,
        cuts: 0,
        cuts_uneven: 0,
        difference_cents: '0',
        abs_difference_cents: '0',
        rate_sales_cents: '0',
        rate_hours: 0,
        // Sales the hours would bring at the average rate of their shift.
        rate_expected_cents: 0,
      });
    return people.get(id);
  };
  for (const list of [schedules, absences, clocks, incidents, tasks, cuts])
    for (const { user_id, ...r } of list.rows) Object.assign(person(user_id), r);
  const shiftRate = new Map<string, { sales: number; hours: number; people: Set<string> }>();
  for (const r of rates.rows) {
    const t = shiftRate.get(r.label) || { sales: 0, hours: 0, people: new Set<string>() };
    t.sales += Number(r.sales_cents);
    t.hours += r.hours;
    t.people.add(r.user_id);
    shiftRate.set(r.label, t);
  }
  for (const r of rates.rows) {
    const p = person(r.user_id),
      t = shiftRate.get(r.label)!;
    p.rate_sales_cents = (BigInt(p.rate_sales_cents) + BigInt(r.sales_cents)).toString();
    p.rate_hours += r.hours;
    p.rate_expected_cents += t.hours ? (r.hours * t.sales) / t.hours : 0;
    // Whoever is the only one in every shift they worked has no one to compare with.
    p.rate_alone = (p.rate_alone ?? true) && t.people.size === 1;
  }
  const names = new Map<string, any>(
    (
      await db.query(
        'SELECT id,name,role,deleted_at IS NOT NULL AS deleted FROM users WHERE id=ANY($1)',
        [[...people.keys()]],
      )
    ).rows.map((u) => [u.id, u]),
  );
  const round = (n: number) => Math.round(n * 100) / 100;
  const list = [...people.values()]
    .map((p) => ({
      ...p,
      employee: names.get(p.user_id)?.name ?? '—',
      role: names.get(p.user_id)?.role,
      deleted: names.get(p.user_id)?.deleted ?? false,
      hours: round(p.hours),
      scheduled_hours: round(p.scheduled_hours),
      rate_hours: round(p.rate_hours),
      rate_expected_cents: Math.round(p.rate_expected_cents).toString(),
      rate_alone: p.rate_alone ?? false,
    }))
    .sort((a, b) => a.employee.localeCompare(b.employee, 'es'));
  const sum = (key: string) => list.reduce((s, p) => s + Number(p[key]), 0);
  return {
    totals: {
      people: list.length,
      scheduled: sum('scheduled'),
      scheduled_hours: round(sum('scheduled_hours')),
      hours: round(sum('hours')),
      absences: sum('absences'),
      late: sum('late'),
      early_exit: sum('early_exit'),
      missing_cut: sum('missing_cut'),
      tasks: sum('tasks'),
      tasks_done: sum('tasks_done'),
      tasks_missed: sum('tasks_missed'),
      cuts: sum('cuts'),
      cuts_uneven: sum('cuts_uneven'),
      difference_cents: list.reduce((s, p) => s + BigInt(p.difference_cents), 0n).toString(),
      abs_difference_cents: list
        .reduce((s, p) => s + BigInt(p.abs_difference_cents), 0n)
        .toString(),
    },
    shift_rates: [...shiftRate].map(([label, { people, ...t }]) => ({
      label,
      sales_cents: String(t.sales),
      hours: round(t.hours),
    })),
    people: list,
  };
}

// Extraordinary expenses registered in Caja general (cash out, stored as negative).
async function expenses(db: pg.PoolClient, zone: string, from: string, to: string) {
  const day = `(t.occurred_at AT TIME ZONE $3)::date`;
  const entries = (
    await db.query(
      `SELECT t.id,${day}::text AS date,t.occurred_at,t.note,(-(t.cash_cents+t.bank_cents))::text AS amount_cents,
         u.name AS employee
       FROM treasury_entries t JOIN users u ON u.id=t.actor_user_id
       WHERE t.kind='expense' AND ${day} BETWEEN $1 AND $2 ORDER BY t.occurred_at DESC`,
      [from, to, zone],
    )
  ).rows;
  const byDay = new Map<string, bigint>();
  for (const e of entries) byDay.set(e.date, (byDay.get(e.date) ?? 0n) + BigInt(e.amount_cents));
  return {
    totals: {
      entries: entries.length,
      amount_cents: entries.reduce((s, e) => s + BigInt(e.amount_cents), 0n).toString(),
    },
    by_day: [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cents]) => ({ date, amount_cents: cents.toString() })),
    entries,
  };
}

// Control de efectivo: every count against what was expected, from the sales cuts and the
// supplier cash closes. Shortages and overages stay apart, so one never hides the other.
async function cash(db: pg.PoolClient, zone: string, from: string, to: string) {
  const counts = `SELECT 'cut' AS source,user_id,register_number::text AS register,label,business_date AS date,
      difference_cents AS diff FROM cuts WHERE business_date BETWEEN $1 AND $2
    UNION ALL
    SELECT 'supplier',actor_user_id,'supplier',NULL,business_date,difference_cents FROM supplier_shifts
    WHERE closed_at IS NOT NULL AND difference_cents IS NOT NULL AND business_date BETWEEN $1 AND $2`;
  const measures = `count(*)::int AS counts,
      count(*) FILTER (WHERE diff<0)::int AS short,
      coalesce(-sum(diff) FILTER (WHERE diff<0),0)::text AS short_cents,
      count(*) FILTER (WHERE diff>0)::int AS over,
      coalesce(sum(diff) FILTER (WHERE diff>0),0)::text AS over_cents`;
  // Groups and sorts by the position of the chosen columns, which may carry an alias.
  const group = (...columns: string[]) => {
    const at = columns.map((_, i) => i + 1).join(',');
    return db.query(
      `SELECT ${columns.join(',')},${measures} FROM (${counts}) d GROUP BY ${at} ORDER BY ${at}`,
      [from, to],
    );
  };
  const [bySource, byDay, byPerson, byRegister, byShift, adjustments] = await serial([
    () => group('source'),
    () => group('date::text AS date'),
    () => group('source', 'user_id'),
    () => group('register'),
    () =>
      db.query(
        `SELECT label,${measures} FROM (${counts}) d WHERE source='cut' GROUP BY label ORDER BY label`,
        [from, to],
      ),
    // Manual adjustments to Caja general: money that appeared or vanished without a count.
    () =>
      db.query(
        `SELECT t.id,(t.occurred_at AT TIME ZONE $3)::date::text AS date,t.kind,t.note,
           t.cash_cents::text,t.bank_cents::text,u.name AS employee
         FROM treasury_entries t JOIN users u ON u.id=t.actor_user_id
         WHERE t.kind IN ('cash_adjustment','bank_adjustment')
           AND (t.occurred_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
         ORDER BY t.occurred_at DESC`,
        [from, to, zone],
      ),
  ]);
  const empty = { counts: 0, short: 0, short_cents: '0', over: 0, over_cents: '0' };
  const strip = ({ source, user_id, register, label, date, ...m }: any) => m;
  const totals = {
    cut: { ...empty, ...strip(bySource.rows.find((r) => r.source === 'cut') ?? {}) },
    supplier: { ...empty, ...strip(bySource.rows.find((r) => r.source === 'supplier') ?? {}) },
  };
  const ids = [...new Set(byPerson.rows.map((r) => r.user_id))];
  const names = new Map<string, any>(
    (
      await db.query(
        'SELECT id,name,deleted_at IS NOT NULL AS deleted FROM users WHERE id=ANY($1)',
        [ids],
      )
    ).rows.map((u) => [u.id, u]),
  );
  const by_person = ids
    .map((id) => ({
      user_id: id,
      employee: names.get(id)?.name ?? '—',
      deleted: names.get(id)?.deleted ?? false,
      cut: {
        ...empty,
        ...strip(byPerson.rows.find((r) => r.user_id === id && r.source === 'cut') ?? {}),
      },
      supplier: {
        ...empty,
        ...strip(byPerson.rows.find((r) => r.user_id === id && r.source === 'supplier') ?? {}),
      },
    }))
    .sort((a, b) => a.employee.localeCompare(b.employee, 'es'));
  return {
    totals: {
      ...totals,
      adjustments: adjustments.rows.length,
      adjustments_cash_cents: adjustments.rows
        .reduce((s, r) => s + BigInt(r.cash_cents), 0n)
        .toString(),
    },
    by_day: byDay.rows,
    by_person,
    by_register: byRegister.rows,
    by_shift: byShift.rows,
    adjustments: adjustments.rows,
  };
}

export async function buildMetrics(db: pg.PoolClient, zone: string, from: string, to: string) {
  const previous = previousPeriod(from, to);
  const s = await sales(db, from, to),
    p = await purchases(db, zone, from, to),
    ps = await sales(db, previous.from, previous.to),
    pp = await purchases(db, zone, previous.from, previous.to),
    sp = await suppliers(db, zone, { from, to }, previous),
    e = await employees(db, zone, from, to),
    pe = await employees(db, zone, previous.from, previous.to),
    x = await expenses(db, zone, from, to),
    px = await expenses(db, zone, previous.from, previous.to),
    c = await cash(db, zone, from, to),
    pc = await cash(db, zone, previous.from, previous.to);
  return {
    range: { from, to },
    previous,
    sales: { ...s, previous: { totals: ps.totals, by_day: ps.by_day } },
    purchases: { ...p, previous: { totals: pp.totals, by_day: pp.by_day } },
    suppliers: sp,
    employees: { ...e, previous: { totals: pe.totals } },
    expenses: { ...x, previous: { totals: px.totals, by_day: px.by_day } },
    cash: { ...c, previous: { totals: pc.totals, by_day: pc.by_day } },
  };
}

metrics.get('/metrics', async (req, res) => {
  const { b, from, to } = await load(req);
  res.json(await transaction(b.id, (db) => buildMetrics(db, b.timezone, from, to)));
});
