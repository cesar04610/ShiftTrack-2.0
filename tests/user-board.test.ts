import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderUsers, activityOf, sessionsOf } from '../apps/web/src/UserBoard.js';

const u = (id: string, name: string, deleted_at: string | null = null) => ({
  id,
  name,
  username: id,
  role: 'employee',
  active: true,
  deleted_at,
});
const c = (id: string, user_id: string, clock_in: string, clock_out: string | null) => ({
  id,
  user_id,
  business_date: clock_in.slice(0, 10),
  clock_in,
  clock_out,
});

test('las fichas van primero activos, luego por sesión más reciente, sin duplicados ni eliminados', () => {
  const users = [
    u('a', 'Ana'),
    u('b', 'Beto'),
    u('c', 'Carla'),
    u('d', 'Dani'),
    u('e', 'Eli', 'x'),
  ];
  const clock = [
    c('1', 'a', '2026-11-08T15:00:00Z', '2026-11-08T22:00:00Z'),
    c('2', 'a', '2026-11-07T15:00:00Z', '2026-11-07T22:00:00Z'),
    c('3', 'b', '2026-11-09T14:00:00Z', null),
    c('4', 'c', '2026-11-09T10:00:00Z', '2026-11-09T12:00:00Z'),
    c('5', 'e', '2026-11-09T15:00:00Z', null),
  ];
  assert.deepEqual(
    orderUsers(users, clock).map((x) => x.id),
    ['b', 'c', 'a', 'd'],
  );
});

test('la actividad de una sesión solo incluye lo del usuario dentro de su ventana', () => {
  const clock = c('1', 'a', '2026-11-09T15:00:00Z', '2026-11-09T20:00:00Z');
  const data = {
    suppliers: [{ id: 's', company: 'Norte' }],
    tasks: [
      { user_id: 'a', title: 'Barrer', completed_at: '2026-11-09T16:00:00Z', note: '' },
      { user_id: 'a', title: 'Fuera', completed_at: '2026-11-09T22:00:00Z', note: '' },
      { user_id: 'b', title: 'Ajena', completed_at: '2026-11-09T16:00:00Z', note: '' },
    ],
    tickets: [
      {
        actor_user_id: 'a',
        supplier_id: 's',
        amount_cents: 1000,
        occurred_at: '2026-11-09T17:00:00Z',
        note: '',
      },
    ],
  };
  const feed = activityOf(data, 'a', clock, Date.parse('2026-11-10T00:00:00Z'));
  assert.deepEqual(
    feed.map((x) => x.text),
    [
      'Registró su entrada',
      'Tarea realizada: Barrer',
      'Pago a Norte: $10.00',
      'Registró su salida',
    ],
  );
  assert.equal(sessionsOf([clock], 'a').length, 1);
});
