import type pg from 'pg';
import { money } from '../../../packages/domain/index.js';

export type DetailLine = { label: string; value: string };

const isId = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const roles: Record<string, string> = {
  superadmin: 'Superadministrador',
  admin: 'Administrador',
  employee: 'Empleado',
};
const movementKinds: Record<string, string> = {
  expense: 'Gasto',
  bank_withdrawal: 'Retiro de banco',
  cash_adjustment: 'Ajuste de efectivo',
  bank_adjustment: 'Ajuste de banco',
};
const correctionKinds: Record<string, string> = {
  documentary: 'Documental',
  refund: 'Reembolso',
};

const amount = (v: unknown) => {
  try {
    return money(String(v));
  } catch {
    return String(v);
  }
};
const day = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
};
const time = (v: unknown) => String(v).slice(0, 5);

// Everything an audit row may point at, looked up once for the whole list.
type Lookups = {
  users: Map<string, string>;
  suppliers: Map<string, string>;
  tickets: Map<string, string>;
  tasks: Map<string, string>;
  shortages: Map<string, string>;
  cuts: Map<string, any>;
  commands: Map<string, any>;
  entries: Map<string, any>;
  matched: Map<string, string>;
};

async function lookups(db: pg.PoolClient, events: any[]): Promise<Lookups> {
  const ids = new Set<string>();
  for (const e of events) for (const v of Object.values(e.payload ?? {})) if (isId(v)) ids.add(v);
  for (const e of events) {
    const data = e.payload?.data;
    if (data && typeof data === 'object')
      for (const v of Object.values(data)) if (isId(v)) ids.add(v);
  }
  const operations = events.map((e) => e.payload?.operation_id).filter(isId);
  // Older confirmed commands only kept their operation id, so their content is read back from the ledgers.
  const commands = new Map<string, any>(
    (
      await db.query('SELECT id,payload FROM supplier_events WHERE id=ANY($1::uuid[])', [
        operations,
      ])
    ).rows.map((r) => [r.id, r.payload]),
  );
  for (const p of commands.values()) for (const v of Object.values(p)) if (isId(v)) ids.add(v);
  const entries = new Map<string, any>(
    (
      await db.query(
        'SELECT source_id,kind,cash_cents::text,bank_cents::text,note FROM treasury_entries WHERE source_id=ANY($1::uuid[])',
        [operations],
      )
    ).rows.map((r) => [r.source_id, r]),
  );
  // Confirmed captures of other kinds are found by who made them and the moment they happened.
  const matched = new Map<string, string>();
  const sources: Record<string, string> = {
    'task.complete': 'SELECT id FROM tasks WHERE user_id=$1 AND completed_at=$2 LIMIT 1',
    'shortage.create': 'SELECT id FROM shortages WHERE actor_user_id=$1 AND occurred_at=$2 LIMIT 1',
    'cut.create': 'SELECT id FROM cuts WHERE user_id=$1 AND occurred_at=$2 LIMIT 1',
  };
  for (const e of events) {
    const at = e.payload?.occurred_at;
    if (!sources[e.action] || e.payload?.data?.id || !e.actor_user_id || !at) continue;
    const found = (await db.query(sources[e.action], [e.actor_user_id, at])).rows[0];
    if (found) {
      matched.set(e.id, found.id);
      ids.add(found.id);
    }
  }
  const list = [...ids];
  const named = async (sql: string) =>
    new Map<string, string>((await db.query(sql, [list])).rows.map((r) => [r.id, r.name]));
  const [users, suppliers, tickets, tasks, shortages, cutRows] = await Promise.all([
    named('SELECT id,name FROM users WHERE id=ANY($1::uuid[])'),
    named('SELECT id,company AS name FROM suppliers WHERE id=ANY($1::uuid[])'),
    db
      .query(
        `SELECT t.id,s.company,t.amount_cents::text AS cents
         FROM tickets t JOIN suppliers s ON s.id=t.supplier_id WHERE t.id=ANY($1::uuid[])`,
        [list],
      )
      .then(
        (r) =>
          new Map<string, string>(r.rows.map((t) => [t.id, `${t.company} por ${money(t.cents)}`])),
      ),
    named(
      `SELECT id,title AS name FROM task_catalog WHERE id=ANY($1::uuid[])
       UNION ALL SELECT id,title FROM tasks WHERE id=ANY($1::uuid[])`,
    ),
    named('SELECT id,product AS name FROM shortages WHERE id=ANY($1::uuid[])'),
    db.query(
      `SELECT c.id,c.business_date::text AS date,c.label,c.register_number,c.sales_cents::text,c.card_cents::text,
         c.declared_cents::text,c.expected_cents::text,c.difference_cents::text,u.name AS employee
       FROM cuts c JOIN users u ON u.id=c.user_id WHERE c.id=ANY($1::uuid[])`,
      [list],
    ),
  ]);
  return {
    users,
    suppliers,
    tickets,
    tasks,
    shortages,
    cuts: new Map(cutRows.rows.map((r) => [r.id, r])),
    commands,
    entries,
    matched,
  };
}

function describe(e: any, k: Lookups): DetailLine[] {
  const raw = e.payload ?? {};
  const op = raw.operation_id;
  const p: Record<string, any> = {
    ...(k.commands.get(op) ?? {}),
    ...(raw.data ?? {}),
    ...raw,
  };
  if (!p.id && k.matched.has(e.id)) p.id = k.matched.get(e.id);
  const lines: DetailLine[] = [];
  const add = (label: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '')
      lines.push({ label, value: String(value) });
  };
  const user = (id: unknown) => (isId(id) ? (k.users.get(id) ?? 'Usuario eliminado') : id);
  const supplier = (id: unknown) =>
    isId(id) ? (k.suppliers.get(id) ?? 'Proveedor eliminado') : id;
  const ticket = (id: unknown) => (isId(id) ? (k.tickets.get(id) ?? 'Ticket no disponible') : id);
  const money_ = (label: string, v: unknown) => v !== undefined && add(label, amount(v));
  const action: string = e.action;
  switch (action) {
    case 'supplier.create':
    case 'supplier.update':
      add('Proveedor', k.suppliers.get(p.id) ?? p.company);
      add('Contacto', p.representative ?? p.contact);
      add('Teléfono', p.phone);
      add('Tipo de producto', p.product_type);
      break;
    case 'suppliers.import':
      add('Proveedores importados', p.imported);
      add('Omitidos (ya existían)', p.skipped);
      break;
    case 'supplier.ticket.create':
      add('Proveedor', supplier(p.supplier_id));
      money_('Importe', p.amount_cents);
      add('Nota', p.note);
      break;
    case 'supplier.ticket.void':
      add('Ticket', ticket(p.id));
      add('Motivo de anulación', p.reason);
      break;
    case 'supplier.balance.add':
      money_('Fondo agregado', p.amount_cents);
      break;
    case 'supplier.shift.open':
      add('Responsable', e.employee);
      break;
    case 'supplier.shift.close':
    case 'supplier.shift.reconcile':
      money_('Efectivo contado', p.counted_cents);
      break;
    case 'supplier.correction':
      add('Ticket', ticket(p.ticket_id));
      add('Tipo', correctionKinds[p.type] ?? p.type);
      money_('Importe', p.amount_cents);
      add('Motivo', p.reason);
      break;
    case 'supplier.pause.request':
    case 'supplier.pause.cancel':
      add(
        'Resultado',
        action.endsWith('request')
          ? 'Se detuvo la captura de la caja de proveedores'
          : 'Se reanudó la caja de proveedores',
      );
      break;
    case 'cut.create':
    case 'cut.manual': {
      const cut = k.cuts.get(p.id);
      const entry = k.entries.get(op);
      add('Empleado', cut?.employee ?? user(p.user_id));
      add(
        'Fecha del turno',
        cut ? day(cut.date) : p.business_date ? day(p.business_date) : undefined,
      );
      add('Turno', cut?.label ?? p.label);
      add('Caja', cut?.register_number ?? p.register_number);
      money_('Ventas', cut?.sales_cents ?? p.sales_cents);
      money_('Tarjeta', cut?.card_cents ?? p.card_cents ?? entry?.bank_cents);
      money_('Efectivo declarado', cut?.declared_cents ?? p.declared_cents ?? entry?.cash_cents);
      if (cut) {
        money_('Efectivo esperado', cut.expected_cents);
        money_('Diferencia', cut.difference_cents);
      }
      add('Nota', p.note);
      break;
    }
    case 'task.complete':
      add('Tarea', k.tasks.get(p.id));
      add('Nota', p.note);
      add('Con fotografía', p.media_id ? 'Sí' : undefined);
      break;
    case 'task.revert':
    case 'task.assignment.deactivate':
      add('Tarea', k.tasks.get(p.id));
      break;
    case 'task.catalog.create':
      add('Tarea', k.tasks.get(p.id));
      break;
    case 'shortage.create':
      add('Producto', k.shortages.get(p.id) ?? p.product);
      add('Nota', p.note);
      break;
    case 'shortage.resolve':
      add('Producto', k.shortages.get(p.id));
      break;
    case 'schedule.create':
    case 'schedule.update':
    case 'schedule.delete':
      add('Empleado', user(p.user_id));
      add('Fecha', p.business_date ? day(p.business_date) : undefined);
      if (p.start_time && p.end_time) add('Horario', `${time(p.start_time)} a ${time(p.end_time)}`);
      else if (p.shift)
        add(
          'Turno',
          `${p.shift === 'morning' ? 'Mañana' : 'Tarde'}${p.half ? ' (medio turno)' : ''}`,
        );
      break;
    case 'schedules.clone':
      add('Semana copiada', p.from ? `${day(p.from)}` : undefined);
      add('Semana destino', p.to ? `${day(p.to)}` : undefined);
      add('Horarios creados', p.inserted);
      break;
    case 'treasury.opening':
      money_('Efectivo total', p.cash_cents);
      money_('Banco', p.bank_cents);
      money_('Caja de proveedores (incluida en el efectivo)', p.supplier_cents);
      break;
    case 'treasury.movement':
      add('Tipo', movementKinds[p.kind] ?? p.kind);
      money_('Importe', p.amount_cents);
      add('Nota', p.note);
      break;
    case 'user.create':
    case 'user.update':
    case 'user.deactivate':
    case 'user.delete':
      add('Usuario', k.users.get(p.id) ?? p.name);
      add('Nombre de acceso', p.username);
      add('Rol', p.role ? (roles[p.role] ?? p.role) : undefined);
      break;
    case 'register.release':
      add('Caja', p.register_number);
      add('Usuario que la tenía', user(p.user_id));
      break;
    case 'branch.deactivate':
      add('Sucursal', p.name);
      break;
    default:
      for (const [key, value] of Object.entries(raw))
        if (typeof value !== 'object') add(key, isId(value) ? '' : value);
  }
  if (!lines.length) add('Detalle', 'Sin información adicional registrada para esta operación.');
  return lines;
}

// Turns raw audit rows into readable "label: value" lines so the report never shows ids or JSON.
export async function auditDetails(db: pg.PoolClient, events: any[]) {
  if (!events.length) return events;
  const found = await lookups(db, events);
  return events.map((e) => ({ ...e, payload: undefined, detail: describe(e, found) }));
}
