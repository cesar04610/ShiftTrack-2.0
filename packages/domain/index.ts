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
