import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { digest, validateCommand } from './security.js';
import {
  assert,
  cents,
  cutAmounts,
  localTime,
  shiftLabel,
  canonical,
  type Command,
} from '../../../packages/domain/index.js';
import { z } from 'zod';
import { notify } from '../../worker/mail.js';
export const commandSchema = z
  .object({
    operation_id: z.uuid(),
    schema_version: z.literal(1),
    type: z.enum([
      'supplier.create',
      'supplier.ticket.create',
      'supplier.ticket.void',
      'supplier.balance.add',
      'supplier.shift.open',
      'supplier.shift.close',
      'supplier.shift.reconcile',
      'cut.create',
      'task.complete',
      'shortage.create',
    ]),
    branch_id: z.uuid(),
    device_id: z.uuid(),
    actor_user_id: z.uuid(),
    grant_id: z.uuid(),
    assignment_epoch: z.number().int().positive(),
    device_seq: z.number().int().nonnegative(),
    expected_version: z.string().regex(/^\d+$/),
    occurred_at: z.iso.datetime(),
    depends_on: z.array(z.uuid()).max(20),
    payload: z.record(z.string(), z.string().max(4000)),
    signature: z.string().max(1024),
  })
  .strict();
const uuid = (v: string) => z.uuid().parse(v);
const required = (v: string) => z.string().trim().min(1).max(2000).parse(v);
async function entry(
  db: pg.PoolClient,
  c: Command,
  kind: string,
  cash: bigint,
  bank = 0n,
  note = '',
) {
  await db.query(
    'INSERT INTO treasury_entries(branch_id,id,source_id,kind,cash_cents,bank_cents,note,actor_user_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      c.branch_id,
      randomUUID(),
      c.operation_id,
      kind,
      cash.toString(),
      bank.toString(),
      note,
      c.actor_user_id,
      c.occurred_at,
    ],
  );
}
export async function processCommand(c: Command, deviceId: string) {
  await validateCommand(c, deviceId);
  return transaction(c.branch_id, async (db) => {
    // Every command locks its branch: deduplication, stream and financial effects commit together.
    const b = (await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [c.branch_id]))
      .rows[0];
    assert(b, 'NOT_FOUND', 'Sucursal no encontrada.', 404);
    const hash = digest(canonical(c));
    const existing = (
      await db.query('SELECT * FROM processed_operations WHERE id=$1', [c.operation_id])
    ).rows[0];
    if (existing) {
      assert(
        existing.request_hash === hash,
        'VERSION_CONFLICT',
        'UUID reutilizado con otro contenido.',
      );
      return existing.result;
    }
    const actor = (
      await db.query(
        'SELECT u.*,g.auth_version AS granted_auth_version FROM users u JOIN grants g ON g.user_id=u.id WHERE g.id=$1 FOR SHARE OF u',
        [c.grant_id],
      )
    ).rows[0];
    assert(
      actor?.active &&
        actor.role === 'employee' &&
        actor.branch_id === c.branch_id &&
        actor.auth_version === actor.granted_auth_version,
      'REQUIRES_ADMIN_REVIEW',
      'La identidad cambió durante el envío. Conserva la captura.',
    );
    for (const id of c.depends_on)
      assert(
        (await db.query('SELECT id FROM processed_operations WHERE id=$1', [id])).rowCount,
        'DEPENDENCY_PENDING',
        'Falta confirmar una operación anterior.',
      );
    const supplier = c.type.startsWith('supplier.');
    if (supplier) {
      assert(!b.pause_ack, 'BOX_PAUSED', 'Caja detenida para corrección administrativa.');
      assert(
        b.device_id === deviceId && b.assignment_epoch === c.assignment_epoch,
        'REQUIRES_ADMIN_REVIEW',
        'El equipo o su asignación cambiaron.',
      );
      assert(
        BigInt(c.expected_version) === BigInt(b.version),
        'VERSION_CONFLICT',
        'La versión de caja cambió. Requiere revisión.',
      );
      assert(
        BigInt(c.device_seq) === BigInt(b.device_seq) + 1n,
        'DEPENDENCY_PENDING',
        'Secuencia de caja incompleta.',
      );
      assert(
        b.initialized,
        'OPENING_REQUIRED',
        'El administrador debe registrar los saldos de arranque.',
      );
    }
    const p = c.payload,
      date = localTime(c.occurred_at, b.timezone).date;
    let balance = BigInt(b.balance_cents);
    const active = b.active_shift
      ? (await db.query('SELECT * FROM supplier_shifts WHERE id=$1', [b.active_shift])).rows[0]
      : null;
    if (
      supplier &&
      active &&
      active.business_date.toISOString().slice(0, 10) !== date &&
      c.type !== 'supplier.shift.reconcile'
    )
      throw Object.assign(Error('Cuenta y reconcilia el turno pendiente del día anterior.'), {
        code: 'PREVIOUS_SHIFT_UNCLOSED',
        status: 409,
      });
    if (c.type === 'supplier.create') {
      await db.query(
        'INSERT INTO suppliers(branch_id,id,company,contact,representative,phone,product_type) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          b.id,
          uuid(p.id),
          required(p.company),
          p.contact || '',
          p.representative || '',
          p.phone || '',
          p.product_type || '',
        ],
      );
    } else if (c.type === 'supplier.shift.open') {
      assert(!active, 'SHIFT_OPEN', 'Ya hay un responsable en la caja.');
      assert(
        (p.previous_close_id || null) === (b.last_closed_shift || null),
        'VERSION_CONFLICT',
        'La apertura debe referir al último cierre.',
      );
      await db.query(
        'INSERT INTO supplier_shifts(branch_id,id,actor_user_id,business_date,opened_at,opening_cents,previous_close_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          b.id,
          uuid(p.id),
          c.actor_user_id,
          date,
          c.occurred_at,
          balance.toString(),
          b.last_closed_shift,
        ],
      );
      await db.query('UPDATE branches SET active_shift=$2 WHERE id=$1', [b.id, p.id]);
    } else if (c.type === 'supplier.shift.close' || c.type === 'supplier.shift.reconcile') {
      assert(active, 'NO_SHIFT', 'No hay turno abierto.');
      assert(
        c.type === 'supplier.shift.reconcile' || active.actor_user_id === c.actor_user_id,
        'FORBIDDEN',
        'Solo el responsable cierra su turno.',
        403,
      );
      if (c.type === 'supplier.shift.reconcile')
        assert(
          active.business_date.toISOString().slice(0, 10) < date,
          'FORBIDDEN',
          'Solo reconcilia un turno de un día anterior.',
          403,
        );
      const counted = cents(p.counted_cents);
      assert(counted >= 0n, 'INVALID_AMOUNT', 'El conteo no puede ser negativo.', 400);
      await db.query(
        'UPDATE supplier_shifts SET closed_at=$2,expected_cents=$3,counted_cents=$4,difference_cents=$5 WHERE id=$1',
        [
          active.id,
          c.occurred_at,
          balance.toString(),
          counted.toString(),
          (counted - balance).toString(),
        ],
      );
      await db.query('UPDATE branches SET active_shift=NULL,last_closed_shift=$2 WHERE id=$1', [
        b.id,
        active.id,
      ]);
      balance = counted;
    } else if (
      c.type === 'supplier.ticket.create' ||
      c.type === 'supplier.balance.add' ||
      c.type === 'supplier.ticket.void'
    ) {
      assert(
        active?.actor_user_id === c.actor_user_id,
        'FORBIDDEN',
        'Abre tu turno o recibe el relevo primero.',
        403,
      );
      if (c.type === 'supplier.ticket.create') {
        const amount = cents(p.amount_cents);
        assert(amount > 0n, 'INVALID_AMOUNT', 'El importe debe ser positivo.', 400);
        assert(
          (await db.query('SELECT id FROM suppliers WHERE id=$1 AND active', [uuid(p.supplier_id)]))
            .rowCount,
          'NOT_FOUND',
          'Proveedor no encontrado en esta sucursal.',
          404,
        );
        await db.query(
          'INSERT INTO tickets(branch_id,id,supplier_id,shift_id,actor_user_id,amount_cents,note,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            b.id,
            uuid(p.id),
            p.supplier_id,
            active.id,
            c.actor_user_id,
            amount.toString(),
            p.note || '',
            c.occurred_at,
          ],
        );
        balance -= amount;
        await entry(db, c, 'supplier_payment', -amount, 0n, p.note || 'Pago a proveedor');
        const baseline = (
          await db.query(
            `SELECT count(*)::integer samples,coalesce(avg(amount_cents),0)::text average FROM tickets
         WHERE supplier_id=$1 AND id<>$2 AND NOT voided AND extract(dow FROM occurred_at AT TIME ZONE $3)=extract(dow FROM $4::timestamptz AT TIME ZONE $3)`,
            [p.supplier_id, p.id, b.timezone, c.occurred_at],
          )
        ).rows[0];
        if (baseline.samples >= 3 && Number(amount) > Number(baseline.average) * 1.2) {
          const message = `Compra inusual: importe mayor al promedio histórico del proveedor para este día de semana (${baseline.samples} muestras).`;
          await db.query(
            'INSERT INTO alerts(branch_id,id,type,message,source_key) VALUES($1,$2,$3,$4,$5)',
            [b.id, randomUUID(), 'supplier_anomaly', message, p.id],
          );
          await notify(
            db,
            b.id,
            `supplier_anomaly:${p.id}`,
            'ShiftTrack · Compra inusual',
            message,
          );
        }
      } else if (c.type === 'supplier.balance.add') {
        const amount = cents(p.amount_cents);
        assert(amount > 0n, 'INVALID_AMOUNT', 'El importe debe ser positivo.', 400);
        balance += amount;
      } else {
        const ticket = (
          await db.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE', [uuid(p.id)])
        ).rows[0];
        assert(
          ticket &&
            !ticket.voided &&
            ticket.actor_user_id === c.actor_user_id &&
            ticket.shift_id === active.id,
          'FORBIDDEN',
          'No puedes anular este ticket.',
          403,
        );
        assert(
          Date.parse(c.occurred_at) - +ticket.occurred_at >= 0 &&
            Date.parse(c.occurred_at) - +ticket.occurred_at <= 300_000,
          'REQUIRES_ADMIN_REVIEW',
          'La anulación propia vence a los cinco minutos.',
        );
        await db.query('UPDATE tickets SET voided=true,void_reason=$2 WHERE id=$1', [
          ticket.id,
          required(p.reason),
        ]);
        balance += BigInt(ticket.amount_cents);
        await entry(db, c, 'supplier_void', BigInt(ticket.amount_cents), 0n, p.reason);
      }
    } else if (c.type === 'cut.create') {
      assert(
        (
          await db.query('SELECT id FROM clock_records WHERE user_id=$1 AND business_date=$2', [
            c.actor_user_id,
            date,
          ])
        ).rowCount,
        'CLOCK_REQUIRED',
        'Registra tu fichaje del día antes del corte.',
      );
      const amounts = cutAmounts(p.sales_cents, p.card_cents, p.declared_cents);
      if (p.schedule_id)
        assert(
          (
            await db.query(
              'SELECT id FROM schedules WHERE id=$1 AND user_id=$2 AND business_date=$3',
              [uuid(p.schedule_id), c.actor_user_id, date],
            )
          ).rowCount,
          'NOT_FOUND',
          'Horario no disponible para este corte.',
          404,
        );
      await db.query(
        'INSERT INTO cuts(branch_id,id,user_id,register_number,business_date,label,sales_cents,card_cents,declared_cents,expected_cents,difference_cents,occurred_at,schedule_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          b.id,
          uuid(p.id),
          c.actor_user_id,
          z.coerce.number().int().positive().parse(p.register_number),
          date,
          shiftLabel(c.occurred_at, b.timezone),
          p.sales_cents,
          p.card_cents,
          p.declared_cents,
          amounts.expected,
          amounts.difference,
          c.occurred_at,
          p.schedule_id || null,
        ],
      );
      await entry(db, c, 'cut', cents(p.declared_cents), cents(p.card_cents), 'Corte de ventas');
    } else if (c.type === 'task.complete') {
      if (p.media_id)
        assert(
          (
            await db.query(
              'SELECT id FROM media_objects WHERE id=$1 AND task_id=$2 AND actor_user_id=$3',
              [uuid(p.media_id), uuid(p.id), c.actor_user_id],
            )
          ).rowCount,
          'DEPENDENCY_PENDING',
          'La fotografía aún no está confirmada.',
        );
      const result = await db.query(
        'UPDATE tasks SET completed_at=$3,note=$4,media_id=$5 WHERE id=$1 AND user_id=$2 AND completed_at IS NULL RETURNING id',
        [uuid(p.id), c.actor_user_id, c.occurred_at, p.note || '', p.media_id || null],
      );
      assert(result.rowCount, 'NOT_FOUND', 'Tarea no disponible para este empleado.', 404);
    } else if (c.type === 'shortage.create') {
      await db.query(
        'INSERT INTO shortages(branch_id,id,actor_user_id,product,note,occurred_at) VALUES($1,$2,$3,$4,$5,$6)',
        [b.id, uuid(p.id), c.actor_user_id, required(p.product), p.note || '', c.occurred_at],
      );
    }
    if (supplier) {
      await db.query(
        'UPDATE branches SET balance_cents=$2,version=version+1,device_seq=$3 WHERE id=$1',
        [b.id, balance.toString(), c.device_seq],
      );
      await db.query('INSERT INTO supplier_events VALUES($1,$2,$3,$4,$5,$6,$7)', [
        b.id,
        c.operation_id,
        c.type,
        c.actor_user_id,
        p.amount_cents || p.counted_cents || null,
        c.occurred_at,
        p,
      ]);
    }
    const result = {
      operation_id: c.operation_id,
      status: 'confirmed',
      balance_cents: balance.toString(),
      version: (BigInt(b.version) + (supplier ? 1n : 0n)).toString(),
    };
    await db.query('INSERT INTO processed_operations VALUES($1,$2,$3,$4)', [
      b.id,
      c.operation_id,
      hash,
      result,
    ]);
    await db.query('INSERT INTO audit_events VALUES($1,$2,$3,$4,$5,now())', [
      b.id,
      randomUUID(),
      c.actor_user_id,
      c.type,
      { operation_id: c.operation_id, device_id: deviceId, occurred_at: c.occurred_at },
    ]);
    return result;
  });
}
