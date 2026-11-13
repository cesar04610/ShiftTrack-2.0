export type Role = 'superadmin' | 'admin' | 'employee';
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export function assert(value: unknown, code: string, message: string, status = 409): asserts value {
  if (!value) throw new AppError(code, message, status);
}
export function cents(value: string): bigint {
  assert(/^-?\d{1,16}$/.test(value), 'INVALID_AMOUNT', 'Importe inválido.', 400);
  const n = BigInt(value);
  assert(
    n >= -9_000_000_000_000_000n && n <= 9_000_000_000_000_000n,
    'INVALID_AMOUNT',
    'Importe fuera de rango.',
    400,
  );
  return n;
}
export function parseMoney(value: string): string {
  assert(
    /^\d{1,12}(\.\d{1,2})?$/.test(value),
    'INVALID_AMOUNT',
    'Escribe un importe positivo con máximo dos decimales.',
    400,
  );
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString();
}
export function money(value: string | bigint): string {
  const n = BigInt(value),
    abs = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}$${(abs / 100n).toLocaleString('es-MX')}.${(abs % 100n).toString().padStart(2, '0')}`;
}
export function localTime(instant: string | Date, zone: string) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (key: string) => p.find((x) => x.type === key)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}
export function shiftLabel(instant: string | Date, zone: string) {
  const { minutes } = localTime(instant, zone);
  return minutes >= 300 && minutes < 900 ? 'Mañana' : 'Tarde';
}
export function shiftBusinessDate(instant: string | Date, zone: string) {
  const { date, minutes } = localTime(instant, zone);
  if (minutes >= 300) return date;
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
export function cutAmounts(sales: string, card: string, declared: string) {
  const s = cents(sales),
    c = cents(card),
    d = cents(declared);
  assert(
    s >= 0n && c >= 0n && d >= 0n && c <= s,
    'INVALID_AMOUNT',
    'Revisa ventas, tarjeta y efectivo.',
    400,
  );
  return { expected: (s - c).toString(), difference: (d - (s - c)).toString() };
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}
export const offlineTypes = [
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
] as const;
export type Command = {
  operation_id: string;
  schema_version: 1;
  type: (typeof offlineTypes)[number];
  branch_id: string;
  device_id: string;
  actor_user_id: string;
  grant_id: string;
  assignment_epoch: number;
  device_seq: number;
  expected_version: string;
  occurred_at: string;
  depends_on: string[];
  payload: Record<string, string>;
  signature?: string;
};
export type User = {
  id: string;
  username: string;
  name: string;
  role: Role;
  branch_id: string | null;
  auth_version: number;
  active: boolean;
};

// Spanish names for audit_events.action, shared by the report screen and its Excel export.
export const auditActions: Record<string, string> = {
  'clock.in': 'Entrada al turno',
  'clock.out': 'Salida del turno',
  'auth.login_failed': 'Intento de acceso fallido',
  'auth.password_change': 'Cambio de contraseña',
  'register.select': 'Caja seleccionada',
  'register.leave': 'Caja dejada',
  'supplier.create': 'Alta de proveedor',
  'supplier.update': 'Edición de proveedor',
  'suppliers.import': 'Importación de proveedores',
  'supplier.ticket.create': 'Ticket de compra',
  'supplier.ticket.void': 'Ticket anulado',
  'supplier.balance.add': 'Fondo a caja proveedores',
  'supplier.shift.open': 'Apertura caja proveedores',
  'supplier.shift.close': 'Cierre caja proveedores',
  'supplier.shift.reconcile': 'Cierre pendiente reconciliado',
  'supplier.correction': 'Corrección a ticket',
  'supplier.pause.request': 'Pausa de caja solicitada',
  'supplier.pause.cancel': 'Pausa de caja cancelada',
  'cut.create': 'Corte de caja',
  'cut.manual': 'Corte capturado por administración',
  'task.complete': 'Tarea completada',
  'task.revert': 'Tarea reabierta',
  'task.catalog.create': 'Tarea creada en catálogo',
  'task.assignment.deactivate': 'Asignación de tarea desactivada',
  'shortage.create': 'Faltante reportado',
  'shortage.resolve': 'Faltante resuelto',
  'schedule.create': 'Horario creado',
  'schedule.update': 'Horario modificado',
  'schedule.delete': 'Horario eliminado',
  'schedules.clone': 'Semana de horarios copiada',
  'treasury.movement': 'Movimiento de caja general',
  'treasury.opening': 'Apertura de caja general',
  'user.create': 'Usuario creado',
  'user.update': 'Usuario modificado',
  'user.deactivate': 'Usuario desactivado',
  'user.delete': 'Usuario eliminado',
  'register.release': 'Caja liberada',
  'branch.deactivate': 'Sucursal eliminada',
};

// Entries this long before a schedule starts count as arriving for it (same rule as the alerts).
export const EARLY_ARRIVAL_MINUTES = 120;
export type ShiftPresence = {
  user_id: string;
  // active: scheduled now and clocked in; left: came and already left; upcoming: not in yet, the
  // schedule has not started; missing: not in yet and the schedule already started;
  // unscheduled: clocked in without a schedule in the current shift.
  status: 'active' | 'left' | 'upcoming' | 'missing' | 'unscheduled';
  schedule?: { start_time: string; end_time: string };
  record?: { id: string; clock_in: string; clock_out: string | null };
  // For unscheduled people who do have a schedule in the other shift of the same work day.
  other_shift?: 'Mañana' | 'Tarde';
};
const timeMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const scheduleShift = (s: { start_time: string }) =>
  timeMinutes(s.start_time) >= 300 && timeMinutes(s.start_time) < 900 ? 'Mañana' : 'Tarde';
// Who should be working in the current shift (morning 05:00–15:00, afternoon 15:00–05:00) and who
// actually is. Administrators without a schedule are listed as active, never as unscheduled.
export function shiftPresence(input: {
  now: string | Date;
  zone: string;
  schedules: { user_id: string; business_date: string; start_time: string; end_time: string }[];
  clock: { id: string; user_id: string; clock_in: string; clock_out: string | null }[];
  users: { id: string; role: string; active: boolean; deleted_at?: string | null }[];
}) {
  const { now, zone } = input,
    shift = shiftLabel(now, zone),
    day = shiftBusinessDate(now, zone),
    current = localTime(now, zone),
    nowMinutes = current.date === day ? current.minutes : current.minutes + 1440;
  const user = (id: string) => input.users.find((u) => u.id === id);
  const today = input.schedules.filter((s) => {
    const u = user(s.user_id);
    return (
      s.business_date.slice(0, 10) === day && u?.active && !u.deleted_at && u.role !== 'superadmin'
    );
  });
  const mine = new Map<string, (typeof today)[number]>();
  for (const s of today.filter((s) => scheduleShift(s) === shift))
    if (!mine.has(s.user_id) || s.start_time < mine.get(s.user_id)!.start_time)
      mine.set(s.user_id, s);
  const rows: ShiftPresence[] = [];
  const open = input.clock.filter((r) => !r.clock_out);
  for (const [userId, s] of mine) {
    const start = timeMinutes(s.start_time),
      end = timeMinutes(s.end_time);
    const records = input.clock
      .filter((r) => r.user_id === userId)
      .filter((r) => {
        const at = localTime(r.clock_in, zone);
        if (at.date === day && at.minutes >= start - EARLY_ARRIVAL_MINUTES && at.minutes < end)
          return true;
        // Still open from earlier the same work day, for example a double shift.
        return !r.clock_out && shiftBusinessDate(r.clock_in, zone) === day;
      })
      .sort((a, b) => Date.parse(b.clock_in) - Date.parse(a.clock_in));
    const record = records.find((r) => !r.clock_out) || records[0];
    const schedule = { start_time: s.start_time, end_time: s.end_time };
    rows.push({
      user_id: userId,
      schedule,
      ...(record ? { record } : {}),
      status: record
        ? record.clock_out
          ? 'left'
          : 'active'
        : nowMinutes < start
          ? 'upcoming'
          : 'missing',
    });
  }
  for (const r of open) {
    if (mine.has(r.user_id) || rows.some((x) => x.record?.id === r.id)) continue;
    const u = user(r.user_id);
    const other = today.find((s) => s.user_id === r.user_id);
    rows.push({
      user_id: r.user_id,
      record: r,
      status: u?.role === 'employee' ? 'unscheduled' : 'active',
      ...(other ? { other_shift: scheduleShift(other) } : {}),
    });
  }
  return { shift, day, rows };
}
