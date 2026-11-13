import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { shiftPresence } from '../packages/domain/index.js';

// America/Chihuahua is UTC-6 all year.
const zone = 'America/Chihuahua';
const at = (local: string) => new Date(`${local}:00-06:00`).toISOString();
const users = ['jenny', 'orlando', 'memo', 'jimena', 'tarde', 'doble'].map((id) => ({
  id,
  role: 'employee',
  active: true,
  deleted_at: null,
}));
users.push({ id: 'admin', role: 'admin', active: true, deleted_at: null });
users.push({ id: 'baja', role: 'employee', active: false, deleted_at: null });
const s = (user_id: string, start: string, end: string, date = '2026-11-13') => ({
  user_id,
  business_date: date,
  start_time: `${start}:00`,
  end_time: `${end}:00`,
});
const schedules = [
  s('jenny', '07:00', '15:00'),
  s('orlando', '07:00', '15:00'),
  s('memo', '07:00', '15:00'),
  s('doble', '07:00', '15:00'),
  s('doble', '15:00', '22:00'),
  s('tarde', '15:00', '22:00'),
  s('baja', '07:00', '15:00'),
];
const status = (r: ReturnType<typeof shiftPresence>) =>
  Object.fromEntries(r.rows.map((x) => [x.user_id, x.status]));

test('mañana: activos, sin entrada y activo sin horario', () => {
  const clock = [
    { id: 'c1', user_id: 'jenny', clock_in: at('2026-11-13T06:55'), clock_out: null },
    { id: 'c2', user_id: 'orlando', clock_in: at('2026-11-13T07:10'), clock_out: null },
    { id: 'c3', user_id: 'jimena', clock_in: at('2026-11-13T07:20'), clock_out: null },
    { id: 'c4', user_id: 'admin', clock_in: at('2026-11-13T08:00'), clock_out: null },
    { id: 'c5', user_id: 'doble', clock_in: at('2026-11-13T07:00'), clock_out: null },
  ];
  const r = shiftPresence({ now: at('2026-11-13T09:00'), zone, schedules, clock, users });
  assert.equal(r.shift, 'Mañana');
  assert.deepEqual(status(r), {
    jenny: 'active',
    orlando: 'active',
    memo: 'missing',
    doble: 'active',
    jimena: 'unscheduled',
    admin: 'active',
  });
});

test('antes de su hora todavía no es falta', () => {
  const r = shiftPresence({ now: at('2026-11-13T06:30'), zone, schedules, clock: [], users });
  assert.equal(status(r).memo, 'upcoming');
});

test('tarde: solo el personal de la tarde; quien sigue de la mañana se señala', () => {
  const clock = [
    // Morning shift that already left, and one still signed in after its shift.
    {
      id: 'm1',
      user_id: 'jenny',
      clock_in: at('2026-11-13T06:55'),
      clock_out: at('2026-11-13T15:02'),
    },
    { id: 'm2', user_id: 'orlando', clock_in: at('2026-11-13T07:00'), clock_out: null },
    // Double shift: the morning entry is still open and covers the afternoon.
    { id: 'd1', user_id: 'doble', clock_in: at('2026-11-13T07:00'), clock_out: null },
  ];
  const r = shiftPresence({ now: at('2026-11-13T16:00'), zone, schedules, clock, users });
  assert.equal(r.shift, 'Tarde');
  assert.deepEqual(status(r), { doble: 'active', tarde: 'missing', orlando: 'unscheduled' });
  assert.equal(r.rows.find((x) => x.user_id === 'orlando')!.other_shift, 'Mañana');
});

test('la tarde después de medianoche sigue en el mismo día operativo', () => {
  const clock = [
    {
      id: 't1',
      user_id: 'tarde',
      clock_in: at('2026-11-13T14:50'),
      clock_out: at('2026-11-13T22:05'),
    },
  ];
  const r = shiftPresence({ now: at('2026-11-14T01:00'), zone, schedules, clock, users });
  assert.equal(r.day, '2026-11-13');
  assert.equal(status(r).tarde, 'left');
});
