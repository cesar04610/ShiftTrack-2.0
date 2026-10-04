import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import type pg from 'pg';
import { identity, deviceIdentity } from './security.js';
import { admin, context, owner, transaction, pool } from './db.js';
import { assert, cents, localTime, type User } from '../../../packages/domain/index.js';
import { smtp, smtpConfigured } from '../../worker/mail.js';
export const modules = express.Router();
async function member(db: pg.PoolClient, branch: string, id: string) {
  assert(
    (
      await db.query(
        "SELECT id FROM users WHERE id=$1 AND branch_id=$2 AND role='employee' AND active",
        [id, branch],
      )
    ).rowCount,
    'NOT_FOUND',
    'Empleado no encontrado.',
    404,
  );
}
async function audit(db: pg.PoolClient, b: string, u: User, action: string, payload: unknown) {
  await db.query('INSERT INTO audit_events VALUES($1,$2,$3,$4,$5,now())', [
    b,
    randomUUID(),
    u.id,
    action,
    payload,
  ]);
}
modules.post('/schedules/clone', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = z.object({ source_date: z.iso.date(), target_date: z.iso.date() }).parse(req.body);
  const source = new Date(`${p.source_date}T00:00:00Z`),
    target = new Date(`${p.target_date}T00:00:00Z`),
    diff = Math.round((+target - +source) / 86400000);
  assert(Math.abs(diff) >= 7, 'INVALID_DATES', 'La semana de destino debe ser distinta.', 400);
  const count = await transaction(b.id, async (db) => {
    const rows = (
      await db.query(
        'SELECT s.* FROM schedules s JOIN users u ON u.id=s.user_id WHERE business_date >= $1::date AND business_date < $1::date+7 AND u.active',
        [p.source_date],
      )
    ).rows;
    let inserted = 0;
    for (const r of rows)
      inserted +=
        (
          await db.query(
            'INSERT INTO schedules SELECT branch_id,$2,user_id,business_date+$3::integer,start_time,end_time FROM schedules WHERE id=$1 ON CONFLICT(branch_id,user_id,business_date,start_time) DO NOTHING',
            [r.id, randomUUID(), diff],
          )
        ).rowCount || 0;
    await audit(db, b.id, user, 'schedules.clone', { ...p, inserted });
    return inserted;
  });
  res.json({ count });
});
modules.post('/tasks/catalog', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = z
    .object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(2000).default(''),
      priority: z.enum(['normal', 'alta']).default('normal'),
    })
    .parse(req.body);
  await transaction(b.id, async (db) => {
    const id = randomUUID();
    await db.query(
      'INSERT INTO task_catalog(branch_id,id,title,description,priority) VALUES($1,$2,$3,$4,$5)',
      [b.id, id, p.title, p.description, p.priority],
    );
    await audit(db, b.id, user, 'task.catalog.create', { id });
  });
  res.status(201).json({ ok: true });
});
modules.post('/tasks/assignments', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = z
    .object({
      catalog_id: z.uuid(),
      user_id: z.uuid(),
      recurrence: z.enum(['once', 'daily', 'weekly']),
      start_date: z.iso.date(),
      weekdays: z.array(z.number().int().min(0).max(6)).default([]),
    })
    .parse(req.body);
  assert(
    p.recurrence !== 'weekly' || p.weekdays.length,
    'INVALID_DAYS',
    'Selecciona al menos un día semanal.',
    400,
  );
  await transaction(b.id, async (db) => {
    await member(db, b.id, p.user_id);
    assert(
      (await db.query('SELECT id FROM task_catalog WHERE id=$1 AND active', [p.catalog_id]))
        .rowCount,
      'NOT_FOUND',
      'Plantilla no disponible.',
      404,
    );
    await db.query(
      'INSERT INTO task_assignments(branch_id,id,catalog_id,user_id,recurrence,start_date,weekdays) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [b.id, randomUUID(), p.catalog_id, p.user_id, p.recurrence, p.start_date, p.weekdays],
    );
    await generateTasks(db, b.id, localTime(new Date(), b.timezone).date);
  });
  res.status(201).json({ ok: true });
});
modules.post('/tasks/:id/revert', async (req, res) => {
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
    await audit(db, b.id, user, 'task.revert', { id });
  });
  res.json({ ok: true });
});
modules.post('/tasks/assignments/:id/deactivate', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  await transaction(b.id, async (db) => {
    await db.query('UPDATE task_assignments SET active=false WHERE id=$1', [
      z.uuid().parse(req.params.id),
    ]);
    await audit(db, b.id, user, 'task.assignment.deactivate', { id: req.params.id });
  });
  res.json({ ok: true });
});
modules.post('/shortages/:id/resolve', async (req, res) => {
  const user = await identity(req.headers.authorization);
  const b = await context(user, req.body.branch_id);
  await transaction(b.id, async (db) => {
    assert(
      (
        await db.query('UPDATE shortages SET resolved=true WHERE id=$1 RETURNING id', [
          z.uuid().parse(req.params.id),
        ])
      ).rowCount,
      'NOT_FOUND',
      'Faltante no encontrado.',
      404,
    );
    await audit(db, b.id, user, 'shortage.resolve', { id: req.params.id });
  });
  res.json({ ok: true });
});
modules.post('/users/:id/update', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const id = z.uuid().parse(req.params.id),
    b = await context(user, req.body.branch_id);
  const p = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
  const target = (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  assert(target, 'NOT_FOUND', 'Cuenta no encontrada.', 404);
  assert(
    user.role === 'superadmin' || (target.role === 'employee' && target.branch_id === b.id),
    'FORBIDDEN',
    'No puedes editar esta cuenta.',
    403,
  );
  await transaction(b.id, async (db) => {
    await db.query('UPDATE users SET name=$2 WHERE id=$1', [id, p.name]);
    await audit(db, b.id, user, 'user.update', { id });
  });
  res.json({ ok: true });
});
modules.post('/suppliers/:id/update', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = z
    .object({
      company: z.string().trim().min(1).max(200),
      contact: z.string().max(500).default(''),
      representative: z.string().max(200).default(''),
      phone: z.string().max(100).default(''),
      product_type: z.string().max(200).default(''),
      active: z.boolean(),
    })
    .parse(req.body);
  await transaction(b.id, async (db) => {
    assert(
      (
        await db.query(
          'UPDATE suppliers SET company=$2,contact=$3,active=$4,representative=$5,phone=$6,product_type=$7 WHERE id=$1 RETURNING id',
          [
            z.uuid().parse(req.params.id),
            p.company,
            p.contact,
            p.active,
            p.representative,
            p.phone,
            p.product_type,
          ],
        )
      ).rowCount,
      'NOT_FOUND',
      'Proveedor no encontrado.',
      404,
    );
    await audit(db, b.id, user, 'supplier.update', { id: req.params.id });
  });
  res.json({ ok: true });
});
modules.post('/supplier-corrections/prepare', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const result = await transaction(b.id, async (db) => {
    const current = (await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [b.id]))
      .rows[0];
    if (!current.pause_token) {
      current.pause_token = randomUUID();
      await db.query('UPDATE branches SET pause_token=$2,pause_ack=false WHERE id=$1', [
        b.id,
        current.pause_token,
      ]);
      await audit(db, b.id, user, 'supplier.pause.request', { pause_token: current.pause_token });
    }
    return { pause_token: current.pause_token, ready: current.pause_ack };
  });
  res.json(result);
});
modules.get('/devices/state', async (req, res) => {
  const d = await deviceIdentity(req.headers.authorization);
  const b = (
    await pool.query(
      'SELECT id,pause_token,pause_ack,version,device_seq,assignment_epoch,device_id FROM branches WHERE id=$1',
      [d.branch_id],
    )
  ).rows[0];
  res.json(b);
});
modules.post('/devices/pause-ack', async (req, res) => {
  const d = await deviceIdentity(req.headers.authorization),
    p = z
      .object({
        pause_token: z.uuid(),
        version: z.string().regex(/^\d+$/),
        device_seq: z.string().regex(/^\d+$/),
      })
      .parse(req.body);
  await transaction(d.branch_id, async (db) => {
    const b = (await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [d.branch_id]))
      .rows[0];
    assert(
      b.device_id === d.id &&
        b.pause_token === p.pause_token &&
        b.version === p.version &&
        b.device_seq === p.device_seq,
      'VERSION_CONFLICT',
      'El equipo aún debe sincronizar su secuencia.',
    );
    await db.query('UPDATE branches SET pause_ack=true WHERE id=$1', [b.id]);
  });
  res.json({ ok: true });
});
modules.post('/supplier-corrections', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = z
    .object({
      ticket_id: z.uuid(),
      type: z.enum(['documentary', 'refund']),
      amount_cents: z.string(),
      reason: z.string().trim().min(3).max(1000),
      pause_token: z.uuid(),
    })
    .parse(req.body);
  const amount = cents(p.amount_cents);
  assert(amount > 0n, 'INVALID_AMOUNT', 'El importe debe ser positivo.', 400);
  await transaction(b.id, async (db) => {
    const branch = (await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [b.id]))
      .rows[0];
    assert(
      branch.pause_ack && branch.pause_token === p.pause_token,
      'DEVICE_NOT_READY',
      'El equipo designado debe detener capturas y confirmar todos sus pendientes.',
    );
    const ticket = (
      await db.query(
        'SELECT t.*,s.closed_at FROM tickets t JOIN supplier_shifts s ON s.branch_id=t.branch_id AND s.id=t.shift_id WHERE t.id=$1',
        [p.ticket_id],
      )
    ).rows[0];
    assert(
      ticket && ticket.closed_at && !ticket.voided,
      'NOT_FOUND',
      'Selecciona un pago de un turno cerrado.',
      404,
    );
    const corrected = BigInt(
      (
        await db.query(
          'SELECT coalesce(sum(amount_cents),0)::text amount FROM supplier_corrections WHERE ticket_id=$1',
          [p.ticket_id],
        )
      ).rows[0].amount,
    );
    assert(
      corrected + amount <= BigInt(ticket.amount_cents),
      'INVALID_AMOUNT',
      'La corrección supera el importe pendiente del pago.',
      400,
    );
    const id = randomUUID(),
      supplier = p.type === 'refund' ? amount : 0n;
    await db.query(
      'INSERT INTO supplier_corrections(branch_id,id,ticket_id,type,amount_cents,treasury_effect_cents,supplier_cash_effect_cents,reason,actor_user_id) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8)',
      [b.id, id, p.ticket_id, p.type, amount.toString(), supplier.toString(), p.reason, user.id],
    );
    await db.query(
      'INSERT INTO treasury_entries(branch_id,id,source_id,kind,cash_cents,note,actor_user_id) VALUES($1,$2,$2,$3,$4,$5,$6)',
      [b.id, id, 'supplier_correction', amount.toString(), p.reason, user.id],
    );
    await db.query(
      'UPDATE branches SET balance_cents=balance_cents+$2,version=version+1,pause_token=NULL,pause_ack=false WHERE id=$1',
      [b.id, supplier.toString()],
    );
    await audit(db, b.id, user, 'supplier.correction', { id, ...p });
  });
  res.json({ ok: true });
});
modules.post('/supplier-corrections/cancel', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  await transaction(b.id, async (db) => {
    await db.query('UPDATE branches SET pause_token=NULL,pause_ack=false WHERE id=$1', [b.id]);
    await audit(db, b.id, user, 'supplier.pause.cancel', {});
  });
  res.json({ ok: true });
});
modules.post('/expense-categories', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  await transaction(b.id, async (db) => {
    await db.query('INSERT INTO expense_categories(branch_id,id,name) VALUES($1,$2,$3)', [
      b.id,
      randomUUID(),
      z.string().trim().min(1).max(100).parse(req.body.name),
    ]);
  });
  res.status(201).json({ ok: true });
});
modules.post('/alerts/settings', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = z
    .object({
      absence_tolerance_minutes: z.number().int().min(0).max(240),
      cut_delay_minutes: z.number().int().min(0).max(240),
      recipients: z.array(z.email()).max(20),
      email_enabled: z.boolean(),
    })
    .parse(req.body);
  if (p.email_enabled) {
    assert(
      smtpConfigured(),
      'SMTP_NOT_CONFIGURED',
      'Configura SMTP en el servidor antes de habilitar correos.',
      400,
    );
    assert(p.recipients.length, 'INVALID_RECIPIENTS', 'Agrega al menos un destinatario.', 400);
    const transport = smtp();
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  }
  await transaction(b.id, async (db) => {
    await db.query(
      'INSERT INTO alert_settings VALUES($1,$2,$3,$4,$5) ON CONFLICT(branch_id) DO UPDATE SET absence_tolerance_minutes=$2,cut_delay_minutes=$3,recipients=$4,email_enabled=$5',
      [b.id, p.absence_tolerance_minutes, p.cut_delay_minutes, p.recipients, p.email_enabled],
    );
    await audit(db, b.id, user, 'alerts.settings', p);
  });
  res.json({ ok: true });
});
modules.post('/notifications/:id/retry', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  const p = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
  await transaction(b.id, async (db) => {
    assert(
      (
        await db.query(
          "UPDATE notification_outbox SET status='pending',next_attempt_at=now() WHERE id=$1 AND status IN ('failed','needs_review') RETURNING id",
          [z.uuid().parse(req.params.id)],
        )
      ).rowCount,
      'NOT_FOUND',
      'Aviso no disponible para reintento.',
      404,
    );
    await audit(db, b.id, user, 'notification.retry', { id: req.params.id, reason: p.reason });
  });
  res.json({ ok: true });
});
modules.post('/alerts/:id/seen', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.body.branch_id);
  await transaction(b.id, async (db) => {
    await db.query('UPDATE alerts SET seen=true WHERE id=$1', [z.uuid().parse(req.params.id)]);
  });
  res.json({ ok: true });
});
modules.get('/reports/export', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.query.branch_id as string, true);
  const book = new ExcelJS.Workbook();
  await transaction(b.id, async (db) => {
    for (const [table, label] of [
      ['clock_records', 'Asistencia'],
      ['schedules', 'Horarios'],
      ['tasks', 'Tareas'],
      ['tickets', 'Tickets'],
      ['cuts', 'Cortes'],
      ['treasury_entries', 'Caja general'],
    ]) {
      const rows = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
      const sheet = book.addWorksheet(label);
      if (rows.length) {
        sheet.columns = Object.keys(rows[0]).map((key) => ({ header: key, key, width: 24 }));
        for (const row of rows) sheet.addRow(row);
      }
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }
  });
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', 'attachment; filename="shifttrack-reportes.xlsx"');
  await book.xlsx.write(res);
  res.end();
});
modules.get('/analytics', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const b = await context(user, req.query.branch_id as string, true);
  res.json(
    await transaction(b.id, async (db) => ({
      spending: (
        await db.query(`SELECT s.id,s.company,count(t.id)::integer tickets,coalesce(sum(t.amount_cents),0)::text gross_cents,
    (coalesce(sum(t.amount_cents),0)-coalesce((SELECT sum(c.amount_cents) FROM supplier_corrections c JOIN tickets tx ON tx.branch_id=c.branch_id AND tx.id=c.ticket_id WHERE tx.supplier_id=s.id),0))::text net_cents
    FROM suppliers s LEFT JOIN tickets t ON t.branch_id=s.branch_id AND t.supplier_id=s.id AND NOT t.voided GROUP BY s.id,s.company ORDER BY s.company`)
      ).rows,
      baselines: (
        await db.query(`SELECT c.user_id,u.name,c.register_number,extract(dow FROM c.business_date)::integer weekday,count(*)::integer samples,round(avg(c.sales_cents))::text average_cents
    FROM cuts c JOIN users u ON u.id=c.user_id GROUP BY c.user_id,u.name,c.register_number,extract(dow FROM c.business_date) ORDER BY u.name,weekday`)
      ).rows,
      daily: (
        await db.query(
          'SELECT business_date,sum(sales_cents)::text sales_cents,sum(declared_cents)::text declared_cents,sum(card_cents)::text card_cents,sum(difference_cents)::text difference_cents FROM cuts GROUP BY business_date ORDER BY business_date',
        )
      ).rows,
      absences: (
        await db.query(
          `SELECT s.id,s.business_date,s.start_time,s.end_time,u.name FROM schedules s JOIN users u ON u.id=s.user_id
   WHERE NOT EXISTS(SELECT 1 FROM clock_records c WHERE c.user_id=s.user_id AND c.business_date=s.business_date) AND s.business_date<= (now() AT TIME ZONE $1)::date ORDER BY s.business_date DESC`,
          [b.timezone],
        )
      ).rows,
    })),
  );
});
export async function generateTasks(db: pg.PoolClient, branch: string, date: string) {
  return (
    (
      await db.query(
        `INSERT INTO tasks(branch_id,id,user_id,title,due_date,priority,assignment_id)
 SELECT a.branch_id,gen_random_uuid(),a.user_id,c.title,$2::date,c.priority,a.id FROM task_assignments a JOIN task_catalog c ON c.branch_id=a.branch_id AND c.id=a.catalog_id JOIN users u ON u.id=a.user_id
 WHERE a.branch_id=$1 AND a.active AND c.active AND u.active AND a.start_date<=$2::date AND
 (a.recurrence='daily' OR (a.recurrence='once' AND a.start_date=$2::date) OR (a.recurrence='weekly' AND extract(dow FROM $2::date)::integer=ANY(a.weekdays)))
 ON CONFLICT(branch_id,assignment_id,due_date) WHERE assignment_id IS NOT NULL DO NOTHING`,
        [branch, date],
      )
    ).rowCount || 0
  );
}
