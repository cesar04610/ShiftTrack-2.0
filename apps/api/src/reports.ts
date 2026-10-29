import express from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import type pg from 'pg';
import { identity } from './security.js';
import { admin, context, transaction } from './db.js';
import { alertsReady } from './alerts.js';
import { auditDetails } from './audit-detail.js';
import { assert, auditActions, money, shiftBusinessDate } from '../../../packages/domain/index.js';

export const reports = express.Router();

// Every report covers one branch (the one picked at sign-in) and a range of business dates.
const range = z.object({
  branch_id: z.string().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
});
const MAX_DAYS = 400;

async function load(req: express.Request) {
  const user = await identity(req.headers.authorization);
  admin(user);
  const q = range.parse(req.query);
  assert(q.from <= q.to, 'INVALID_RANGE', 'La fecha inicial debe ser anterior a la final.', 400);
  assert(
    (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= MAX_DAYS,
    'INVALID_RANGE',
    'El rango máximo es de 400 días.',
    400,
  );
  const b = await context(user, q.branch_id, true);
  return { b, from: q.from, to: q.to };
}

async function build(db: pg.PoolClient, zone: string, from: string, to: string) {
  const day = (column: string) => `(${column} AT TIME ZONE $3)::date`;
  const args = [from, to, zone];
  // Only the time-zone queries use $3, so each query gets just the parameters it names.
  const rows = async (sql: string) =>
    (await db.query(sql, sql.includes('$3') ? args : args.slice(0, 2))).rows;
  const alerts = await alertsReady(db);

  const tickets = await rows(
    `SELECT t.id,t.occurred_at,${day('t.occurred_at')}::text AS date,s.company,u.name AS employee,
       t.amount_cents::text,t.note,t.voided,t.void_reason,
       coalesce((SELECT sum(c.amount_cents) FROM supplier_corrections c WHERE c.ticket_id=t.id),0)::text AS corrected_cents
     FROM tickets t JOIN suppliers s ON s.id=t.supplier_id JOIN users u ON u.id=t.actor_user_id
     WHERE ${day('t.occurred_at')} BETWEEN $1 AND $2 ORDER BY t.occurred_at DESC`,
  );
  const corrections = await rows(
    `SELECT c.id,c.occurred_at,s.company,u.name AS employee,c.type,c.amount_cents::text,c.reason
     FROM supplier_corrections c JOIN tickets t ON t.id=c.ticket_id JOIN suppliers s ON s.id=t.supplier_id
     JOIN users u ON u.id=c.actor_user_id
     WHERE ${day('c.occurred_at')} BETWEEN $1 AND $2 ORDER BY c.occurred_at DESC`,
  );
  const shifts = await rows(
    `SELECT sh.id,sh.business_date::text AS date,u.name AS employee,sh.opened_at,sh.closed_at,
       sh.opening_cents::text,sh.expected_cents::text,sh.counted_cents::text,sh.difference_cents::text
     FROM supplier_shifts sh JOIN users u ON u.id=sh.actor_user_id
     WHERE sh.business_date BETWEEN $1 AND $2 ORDER BY sh.opened_at DESC`,
  );

  const attendance = await rows(
    `SELECT c.id,c.user_id,u.name AS employee,c.business_date::text AS date,c.clock_in,c.clock_out,
       (SELECT string_agg(to_char(s.start_time,'HH24:MI')||'–'||to_char(s.end_time,'HH24:MI'),', ' ORDER BY s.start_time)
        FROM schedules s WHERE s.user_id=c.user_id AND s.business_date=c.business_date) AS schedule
     FROM clock_records c JOIN users u ON u.id=c.user_id
     WHERE c.business_date BETWEEN $1 AND $2 ORDER BY c.clock_in DESC`,
  );
  // Same rule as the absence alert: a finished schedule with no entry from 2 hours before its start.
  const absences = await rows(
    `SELECT s.id,s.user_id,u.name AS employee,s.business_date::text AS date,
       to_char(s.start_time,'HH24:MI') AS start_time,to_char(s.end_time,'HH24:MI') AS end_time
     FROM schedules s JOIN users u ON u.id=s.user_id
     WHERE s.business_date BETWEEN $1 AND $2 AND ((s.business_date+s.end_time) AT TIME ZONE $3)<now()
       AND NOT EXISTS(SELECT 1 FROM clock_records c WHERE c.user_id=s.user_id
         AND c.clock_in>=((s.business_date+s.start_time) AT TIME ZONE $3)-interval '2 hours'
         AND c.clock_in<((s.business_date+s.end_time) AT TIME ZONE $3))
     ORDER BY s.business_date DESC,s.start_time`,
  );
  const incidents = alerts
    ? await rows(
        `SELECT a.id,a.kind,a.user_id,a.business_date::text AS date,a.message,a.occurred_at
         FROM alert_log a WHERE a.kind IN ('late','early_exit','missing_cut') AND a.business_date BETWEEN $1 AND $2
         ORDER BY a.occurred_at DESC`,
      )
    : [];
  // Undone tasks from a work day that already ended can no longer be done: they were missed.
  const workDay = shiftBusinessDate(new Date(), zone);
  const tasks = (
    await rows(
      `SELECT t.id,t.user_id,u.name AS employee,t.title,t.due_date::text AS date,t.priority,t.completed_at,t.note,t.media_id
       FROM tasks t JOIN users u ON u.id=t.user_id
       WHERE t.due_date BETWEEN $1 AND $2 ORDER BY t.due_date DESC,u.name`,
    )
  ).map((t) => ({ ...t, missed: !t.completed_at && t.date < workDay }));
  const schedules = await rows(
    `SELECT s.user_id,count(*)::integer AS scheduled,
       sum(extract(epoch FROM (s.end_time-s.start_time)))/3600 AS scheduled_hours
     FROM schedules s WHERE s.business_date BETWEEN $1 AND $2 GROUP BY s.user_id`,
  );

  // One line per person with any activity in the range.
  const people = new Map<string, any>();
  const person = (id: string, name: string) => {
    if (!people.has(id))
      people.set(id, {
        user_id: id,
        employee: name,
        scheduled: 0,
        scheduled_hours: 0,
        days: new Set<string>(),
        hours: 0,
        open: 0,
        absences: 0,
        late: 0,
        early_exit: 0,
        missing_cut: 0,
        tasks: 0,
        tasks_done: 0,
        tasks_missed: 0,
      });
    return people.get(id);
  };
  const ids = [...new Set([...schedules, ...incidents].map((r) => r.user_id).filter(Boolean))];
  const names = new Map<string, string>(
    (await db.query('SELECT id,name FROM users WHERE id=ANY($1)', [ids])).rows.map((u) => [
      u.id,
      u.name,
    ]),
  );
  for (const s of schedules) {
    const p = person(s.user_id, names.get(s.user_id) || '—');
    p.scheduled = s.scheduled;
    p.scheduled_hours = Number(s.scheduled_hours);
  }
  for (const r of attendance) {
    const p = person(r.user_id, r.employee);
    p.days.add(r.date);
    if (r.clock_out) p.hours += (+r.clock_out - +r.clock_in) / 3_600_000;
    else p.open++;
  }
  for (const r of absences) person(r.user_id, r.employee).absences++;
  for (const r of incidents)
    if (r.user_id) person(r.user_id, names.get(r.user_id) || '—')[r.kind]++;
  for (const t of tasks) {
    const p = person(t.user_id, t.employee);
    p.tasks++;
    if (t.completed_at) p.tasks_done++;
    if (t.missed) p.tasks_missed++;
  }
  const staff = [...people.values()]
    .map(({ days, ...p }) => ({
      ...p,
      days: days.size,
      hours: Math.round(p.hours * 100) / 100,
      scheduled_hours: Math.round(p.scheduled_hours * 100) / 100,
    }))
    .sort((a, b) => a.employee.localeCompare(b.employee, 'es'));

  const shortages = await rows(
    `SELECT s.id,s.product,s.note,s.occurred_at,s.resolved,u.name AS employee
     FROM shortages s JOIN users u ON u.id=s.actor_user_id
     WHERE ${day('s.occurred_at')} BETWEEN $1 AND $2 ORDER BY s.occurred_at DESC`,
  );
  const auditRows = await rows(
    `SELECT a.id,a.action,a.received_at,a.payload,a.actor_user_id,coalesce(u.name,'Sistema') AS employee
     FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id
     WHERE ${day('a.received_at')} BETWEEN $1 AND $2 ORDER BY a.received_at DESC LIMIT 2000`,
  );
  const audit = await auditDetails(db, auditRows);

  const live = tickets.filter((t) => !t.voided);
  const sum = (list: any[], key: string) => list.reduce((s, r) => s + BigInt(r[key] ?? 0), 0n);
  const suppliers = new Map<string, any>();
  const daily = new Map<string, any>();
  for (const t of live) {
    const s = suppliers.get(t.company) || {
      company: t.company,
      tickets: 0,
      gross: 0n,
      corrected: 0n,
    };
    s.tickets++;
    s.gross += BigInt(t.amount_cents);
    s.corrected += BigInt(t.corrected_cents);
    suppliers.set(t.company, s);
    const d = daily.get(t.date) || { date: t.date, tickets: 0, gross: 0n };
    d.tickets++;
    d.gross += BigInt(t.amount_cents);
    daily.set(t.date, d);
  }
  const gross = sum(live, 'amount_cents'),
    corrected = sum(live, 'corrected_cents');
  return {
    range: { from, to },
    expenses: {
      totals: {
        tickets: live.length,
        voided: tickets.length - live.length,
        gross_cents: gross.toString(),
        corrected_cents: corrected.toString(),
        net_cents: (gross - corrected).toString(),
        shift_difference_cents: sum(shifts, 'difference_cents').toString(),
      },
      by_supplier: [...suppliers.values()]
        .sort((a, b) => (b.gross > a.gross ? 1 : b.gross < a.gross ? -1 : 0))
        .map((s) => ({
          company: s.company,
          tickets: s.tickets,
          gross_cents: s.gross.toString(),
          corrected_cents: s.corrected.toString(),
          net_cents: (s.gross - s.corrected).toString(),
        })),
      by_day: [...daily.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((d) => ({ date: d.date, tickets: d.tickets, gross_cents: d.gross.toString() })),
      tickets,
      corrections,
      shifts,
    },
    staff: {
      totals: {
        hours: Math.round(staff.reduce((s, p) => s + p.hours, 0) * 100) / 100,
        absences: absences.length,
        late: staff.reduce((s, p) => s + p.late, 0),
        early_exit: staff.reduce((s, p) => s + p.early_exit, 0),
        tasks: tasks.length,
        tasks_done: tasks.filter((t) => t.completed_at).length,
        tasks_missed: tasks.filter((t) => t.missed).length,
      },
      people: staff,
      attendance,
      absences,
      incidents,
    },
    operations: {
      totals: {
        shortages: shortages.length,
        shortages_open: shortages.filter((s) => !s.resolved).length,
        tasks: tasks.length,
        tasks_done: tasks.filter((t) => t.completed_at).length,
        tasks_missed: tasks.filter((t) => t.missed).length,
      },
      shortages,
      tasks,
    },
    audit: { events: audit, truncated: audit.length === 2000 },
  };
}

reports.get('/reports', async (req, res) => {
  const { b, from, to } = await load(req);
  res.json(await transaction(b.id, (db) => build(db, b.timezone, from, to)));
});

const kinds: Record<string, string> = {
  late: 'Retardo',
  early_exit: 'Salida anticipada',
  missing_cut: 'Sin corte',
};
const localDate = (value: string | Date | null, zone: string) =>
  value
    ? new Intl.DateTimeFormat('es-MX', {
        timeZone: zone,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value))
    : '';
const pesos = (value: string | null) => (value == null ? '' : money(value));

// One sheet per section, with headings in Spanish and only the chosen range.
reports.get('/reports/export', async (req, res) => {
  const { b, from, to } = await load(req);
  const r = await transaction(b.id, (db) => build(db, b.timezone, from, to));
  const zone = b.timezone;
  const book = new ExcelJS.Workbook();
  const sheet = (name: string, headers: string[], data: unknown[][]) => {
    const s = book.addWorksheet(name);
    s.addRow([`${b.name} · ${name} · ${from} a ${to}`]).font = { bold: true, size: 13 };
    s.addRow([]);
    const head = s.addRow(headers);
    head.font = { bold: true };
    head.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F6' } };
    });
    for (const row of data) s.addRow(row);
    s.columns.forEach((c, i) => {
      c.width = Math.min(
        48,
        Math.max(
          12,
          headers[i]?.length + 2 || 12,
          ...data.map((d) => String(d[i] ?? '').length + 2),
        ),
      );
    });
    s.views = [{ state: 'frozen', ySplit: 3 }];
  };
  const e = r.expenses;
  sheet(
    'Gastos por proveedor',
    ['Proveedor', 'Tickets', 'Compras', 'Correcciones', 'Neto'],
    [
      ...e.by_supplier.map((s) => [
        s.company,
        s.tickets,
        pesos(s.gross_cents),
        pesos(s.corrected_cents),
        pesos(s.net_cents),
      ]),
      [
        'Total',
        e.totals.tickets,
        pesos(e.totals.gross_cents),
        pesos(e.totals.corrected_cents),
        pesos(e.totals.net_cents),
      ],
    ],
  );
  sheet(
    'Tickets',
    ['Fecha', 'Proveedor', 'Importe', 'Correcciones', 'Estado', 'Registró', 'Nota'],
    e.tickets.map((t) => [
      localDate(t.occurred_at, zone),
      t.company,
      pesos(t.amount_cents),
      pesos(t.corrected_cents),
      t.voided ? `Anulado: ${t.void_reason || ''}` : 'Registrado',
      t.employee,
      t.note,
    ]),
  );
  sheet(
    'Caja proveedores',
    ['Fecha', 'Responsable', 'Apertura', 'Esperado', 'Contado', 'Diferencia', 'Cierre'],
    e.shifts.map((s) => [
      s.date,
      s.employee,
      pesos(s.opening_cents),
      pesos(s.expected_cents),
      pesos(s.counted_cents),
      pesos(s.difference_cents),
      s.closed_at ? localDate(s.closed_at, zone) : 'Abierto',
    ]),
  );
  sheet(
    'Personal',
    [
      'Empleado',
      'Turnos programados',
      'Horas programadas',
      'Días trabajados',
      'Horas trabajadas',
      'Faltas',
      'Retardos',
      'Salidas anticipadas',
      'Tareas',
      'Tareas cumplidas',
      'Tareas no realizadas',
    ],
    r.staff.people.map((p) => [
      p.employee,
      p.scheduled,
      p.scheduled_hours,
      p.days,
      p.hours,
      p.absences,
      p.late,
      p.early_exit,
      p.tasks,
      p.tasks_done,
      p.tasks_missed,
    ]),
  );
  sheet(
    'Asistencia',
    ['Empleado', 'Fecha', 'Horario', 'Entrada', 'Salida', 'Horas'],
    r.staff.attendance.map((a) => [
      a.employee,
      a.date,
      a.schedule || 'Sin horario',
      localDate(a.clock_in, zone),
      a.clock_out ? localDate(a.clock_out, zone) : 'En curso',
      a.clock_out ? Math.round(((+a.clock_out - +a.clock_in) / 3_600_000) * 100) / 100 : '',
    ]),
  );
  sheet(
    'Faltas e incidencias',
    ['Fecha', 'Tipo', 'Detalle'],
    [
      ...r.staff.absences.map((a) => [
        a.date,
        'Falta',
        `${a.employee} · horario ${a.start_time}–${a.end_time}`,
      ]),
      ...r.staff.incidents.map((i) => [i.date, kinds[i.kind] || i.kind, i.message]),
    ],
  );
  sheet(
    'Faltantes',
    ['Fecha', 'Producto', 'Reportó', 'Nota', 'Estado'],
    r.operations.shortages.map((s) => [
      localDate(s.occurred_at, zone),
      s.product,
      s.employee,
      s.note,
      s.resolved ? 'Resuelto' : 'Pendiente',
    ]),
  );
  sheet(
    'Tareas',
    ['Fecha', 'Tarea', 'Empleado', 'Prioridad', 'Estado', 'Nota'],
    r.operations.tasks.map((t) => [
      t.date,
      t.title,
      t.employee,
      t.priority === 'alta' ? 'Alta' : 'Normal',
      t.completed_at
        ? `Cumplida ${localDate(t.completed_at, zone)}`
        : t.missed
          ? 'No realizada'
          : 'Pendiente',
      t.note,
    ]),
  );
  sheet(
    'Auditoría',
    ['Fecha', 'Acción', 'Usuario'],
    r.audit.events.map((a) => [
      localDate(a.received_at, zone),
      auditActions[a.action] || a.action,
      a.employee,
    ]),
  );
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="reportes-${from}-a-${to}.xlsx"`);
  await book.xlsx.write(res);
  res.end();
});
