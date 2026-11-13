import type pg from 'pg';
import { randomUUID } from 'node:crypto';
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
const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const setupName = (c: any) =>
  `${c.weekday == null ? '' : `${dayNames[c.weekday]} · `}Caja ${c.register_number} · ${c.half ? 'Medio turno ' : 'Turno '}${c.shift === 'morning' ? 'mañana' : 'tarde'}`;

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
  shifts: Map<string, any>;
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
  // A closed supplier shift is found by the instant it closed, which is the time the command carries.
  const shiftOf = new Map<string, string>();
  for (const e of events) {
    const at = e.payload?.occurred_at;
    if (!e.action.startsWith('supplier.shift.c') && e.action !== 'supplier.shift.reconcile')
      continue;
    if (!at) continue;
    const found = (
      await db.query('SELECT id FROM supplier_shifts WHERE closed_at=$1 LIMIT 1', [at])
    ).rows[0];
    if (found) {
      shiftOf.set(e.id, found.id);
      ids.add(found.id);
    }
  }
  const list = [...ids];
  const named = async (sql: string) =>
    new Map<string, string>((await db.query(sql, [list])).rows.map((r) => [r.id, r.name]));
  const [users, suppliers, tickets, tasks, shortages, cutRows, shiftRows] = await Promise.all([
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
    db.query(
      `SELECT sh.id,u.name AS employee,sh.expected_cents::text,sh.counted_cents::text,sh.difference_cents::text
       FROM supplier_shifts sh JOIN users u ON u.id=sh.actor_user_id WHERE sh.id=ANY($1::uuid[])`,
      [list],
    ),
  ]);
  for (const [eventId, shiftId] of shiftOf) matched.set(eventId, shiftId);
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
    shifts: new Map(shiftRows.rows.map((r) => [r.id, r])),
  };
}

function describe(e: any, k: Lookups, zone: string): DetailLine[] {
  // Rows written since the snapshot was introduced already carry their readable detail.
  if (Array.isArray(e.payload?.detail) && e.payload.detail.length) return e.payload.detail;
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
  const money_ = (label: string, v: unknown) => v != null && add(label, amount(v));
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
    case 'supplier.shift.reconcile': {
      const shift = k.shifts.get(p.id);
      add('Responsable del turno', shift?.employee);
      money_('Efectivo esperado', shift?.expected_cents);
      money_('Efectivo contado', shift?.counted_cents ?? p.counted_cents);
      money_('Diferencia', shift?.difference_cents);
      break;
    }
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
    case 'task.create':
    case 'task.delete':
      add('Tarea', p.title);
      add('Persona', k.users.get(p.user_id));
      add('Fecha', p.due_date);
      break;
    case 'task.setup.create':
    case 'task.setup.update':
    case 'task.setup.delete':
      add('Tarea', p.title);
      if (p.shift) add('Lista', setupName(p));
      break;
    case 'task.setup.copy':
      add('De', setupName(p.from));
      add('A', setupName(p.to));
      add('Tareas copiadas', p.copied);
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
    case 'clock.in':
    case 'clock.out': {
      const at = (v: string) =>
        new Intl.DateTimeFormat('es-MX', {
          timeZone: zone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(v));
      add('Empleado', e.employee);
      add('Rol', roles[e.clock.role] ?? e.clock.role);
      add('Fecha del turno', day(e.clock.business_date));
      add('Entrada (inicio de sesión)', at(e.clock.clock_in));
      add('Salida', e.clock.clock_out ? at(e.clock.clock_out) : 'Sesión en curso');
      break;
    }
    case 'register.select':
    case 'register.leave':
      add('Caja', p.register_number);
      break;
    case 'auth.login_failed':
      add('Resultado', 'Contraseña incorrecta para esta cuenta');
      break;
    case 'auth.password_change':
      add('Resultado', 'El usuario cambió su contraseña y sus sesiones se cerraron');
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
export async function auditDetails(db: pg.PoolClient, events: any[], zone: string) {
  if (!events.length) return events;
  const found = await lookups(db, events);
  return events.map((e) => ({ ...e, payload: undefined, detail: describe(e, found, zone) }));
}

// The single way to write an audit row: the readable detail is captured at that moment, so the
// log keeps saying what happened even if names or records change later.
export async function writeAudit(
  db: pg.PoolClient,
  branch: string,
  actor: string | null,
  action: string,
  payload: Record<string, unknown>,
  zone = 'America/Chihuahua',
) {
  let detail: DetailLine[] = [];
  // A savepoint keeps a failed lookup from aborting the financial transaction around it.
  await db.query('SAVEPOINT audit_detail');
  try {
    const employee = actor
      ? ((await db.query('SELECT name FROM users WHERE id=$1', [actor])).rows[0]?.name ?? 'Sistema')
      : 'Sistema';
    const [event] = await auditDetails(
      db,
      [{ id: randomUUID(), action, payload, actor_user_id: actor, employee }],
      zone,
    );
    detail = event.detail;
    await db.query('RELEASE SAVEPOINT audit_detail');
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT audit_detail');
  }
  await db.query(
    'INSERT INTO audit_events(branch_id,id,actor_user_id,action,payload) VALUES($1,$2,$3,$4,$5)',
    [branch, randomUUID(), actor, action, { ...payload, ...(detail.length ? { detail } : {}) }],
  );
}
