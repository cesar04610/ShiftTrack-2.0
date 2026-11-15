import express from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { identity } from './security.js';
import { admin, context, transaction } from './db.js';
import { assert } from '../../../packages/domain/index.js';

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

export async function buildMetrics(db: pg.PoolClient, zone: string, from: string, to: string) {
  const previous = previousPeriod(from, to);
  const s = await sales(db, from, to),
    p = await purchases(db, zone, from, to),
    ps = await sales(db, previous.from, previous.to),
    pp = await purchases(db, zone, previous.from, previous.to),
    sp = await suppliers(db, zone, { from, to }, previous);
  return {
    range: { from, to },
    previous,
    sales: { ...s, previous: { totals: ps.totals, by_day: ps.by_day } },
    purchases: { ...p, previous: { totals: pp.totals, by_day: pp.by_day } },
    suppliers: sp,
  };
}

metrics.get('/metrics', async (req, res) => {
  const { b, from, to } = await load(req);
  res.json(await transaction(b.id, (db) => buildMetrics(db, b.timezone, from, to)));
});
