import { test, before, after } from 'node:test';
import { strict as a } from 'node:assert';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
if (
  !process.env.MIGRATION_DATABASE_URL ||
  process.env.NODE_ENV === 'production' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(process.env.MIGRATION_DATABASE_URL).hostname,
  )
)
  throw Error('Las pruebas requieren PostgreSQL local.');
process.env.NODE_ENV = 'test';
const { app } = await import('../apps/api/src/server.js');
const { pool } = await import('../apps/api/src/db.js');
const { issueSession } = await import('../apps/api/src/security.js');
const { previousPeriod } = await import('../apps/api/src/metrics.js');
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const branch = randomUUID(),
  other = randomUUID();
let server: ReturnType<typeof app.listen>,
  base: string,
  adminToken: string,
  employeeToken: string,
  superToken: string,
  adminId: string,
  employeeId: string,
  otherAdminId: string;
async function get(path: string, token = adminToken) {
  const response = await fetch(`${base}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}
async function cut(
  target: string,
  user: string,
  date: string,
  label: string,
  register: number,
  sales: number,
  card: number,
) {
  await db.query(
    `INSERT INTO cuts(branch_id,id,user_id,register_number,business_date,label,sales_cents,card_cents,
       declared_cents,expected_cents,difference_cents,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,0,$10)`,
    [
      target,
      randomUUID(),
      user,
      register,
      date,
      label,
      sales,
      card,
      sales - card,
      `${date}T20:00:00Z`,
    ],
  );
}
const supplier = randomUUID(),
  dairy = randomUUID(),
  old = randomUUID(),
  shift = randomUUID();
async function ticket(user: string, at: string, amount: number, voided = false, from = supplier) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO tickets(branch_id,id,supplier_id,shift_id,actor_user_id,amount_cents,occurred_at,voided,void_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [branch, id, from, shift, user, amount, at, voided, voided ? 'Error de captura' : null],
  );
  return id;
}

before(async () => {
  await db.connect();
  await db.query('INSERT INTO branches(id,name,register_count) VALUES($1,$2,2),($3,$4,1)', [
    branch,
    'Métricas prueba',
    other,
    'Otra sucursal',
  ]);
  for (const [role, home] of [
    ['admin', branch],
    ['employee', branch],
    ['admin', other],
    ['superadmin', null],
  ]) {
    const u = (
      await db.query(
        'INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(), `${role}-${randomUUID().slice(0, 8)}`, `Persona ${role}`, role, home],
      )
    ).rows[0];
    if (role === 'superadmin') superToken = (await issueSession(u)).access_token;
    else if (home === other) otherAdminId = u.id;
    else if (role === 'admin') {
      adminId = u.id;
      adminToken = (await issueSession(u)).access_token;
    } else {
      employeeId = u.id;
      employeeToken = (await issueSession(u)).access_token;
    }
  }
  // Periodo elegido: domingo 1 al sábado 7 de marzo de 2026. Anterior: 22 al 28 de febrero.
  await cut(branch, employeeId, '2026-03-02', 'Mañana', 1, 100_000, 30_000);
  await cut(branch, employeeId, '2026-03-02', 'Tarde', 2, 50_000, 0);
  await cut(branch, adminId, '2026-03-04', 'Mañana', 1, 60_000, 60_000);
  await cut(branch, employeeId, '2026-02-25', 'Mañana', 1, 100_000, 10_000);
  // Fuera del periodo y de otra sucursal: no deben contar.
  await cut(branch, employeeId, '2026-03-08', 'Mañana', 1, 999_900, 0);
  await cut(other, otherAdminId, '2026-03-02', 'Mañana', 1, 777_700, 0);

  await db.query('INSERT INTO suppliers(branch_id,id,company) VALUES($1,$2,$3)', [
    branch,
    supplier,
    'Abarrotes del Norte',
  ]);
  await db.query(
    `INSERT INTO supplier_shifts(branch_id,id,actor_user_id,business_date,opened_at,opening_cents)
     VALUES($1,$2,$3,'2026-02-25','2026-02-25T14:00:00Z',0)`,
    [branch, shift, employeeId],
  );
  // 18:00 en Chihuahua es 00:00 UTC del día siguiente: cuenta el 2 de marzo.
  const corrected = await ticket(employeeId, '2026-03-03T00:00:00Z', 20_000);
  await ticket(employeeId, '2026-03-04T18:00:00Z', 10_000);
  await ticket(employeeId, '2026-03-04T18:02:00Z', 7_000, true);
  await ticket(employeeId, '2026-02-25T18:00:00Z', 30_000);
  // Lácteos compró solo en el periodo anterior: dejó de venir. Su ticket del 10 de marzo es
  // posterior al periodo y no cuenta como su última visita.
  await db.query(
    `INSERT INTO suppliers(branch_id,id,company,product_type,active) VALUES($1,$2,'Lácteos Sierra','Lácteos',false),
       ($1,$3,'Proveedor antiguo','',true)`,
    [branch, dairy, old],
  );
  await ticket(employeeId, '2026-02-26T18:00:00Z', 8_000, false, dairy);
  await ticket(employeeId, '2026-03-10T18:00:00Z', 9_000, false, dairy);
  // Fuera de ambos periodos: no aparece.
  await ticket(employeeId, '2026-01-10T18:00:00Z', 4_000, false, old);
  await db.query(
    `INSERT INTO supplier_corrections(branch_id,id,ticket_id,type,amount_cents,treasury_effect_cents,
       supplier_cash_effect_cents,reason,actor_user_id,occurred_at)
     VALUES($1,$2,$3,'refund',5000,0,5000,'Devolución',$4,'2026-03-03T19:00:00Z')`,
    [branch, randomUUID(), corrected, adminId],
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await db.end();
});

test('periodo anterior: los mismos días, justo antes del elegido', () => {
  a.deepEqual(previousPeriod('2026-03-01', '2026-03-07'), { from: '2026-02-22', to: '2026-02-28' });
  a.deepEqual(previousPeriod('2026-03-01', '2026-03-31'), { from: '2026-01-29', to: '2026-02-28' });
  a.deepEqual(previousPeriod('2026-11-15', '2026-11-15'), { from: '2026-11-14', to: '2026-11-14' });
  a.deepEqual(previousPeriod('2026-01-01', '2026-12-31'), { from: '2025-01-01', to: '2025-12-31' });
});

test('métricas de ventas: totales, comparación, turno, día de la semana y caja', async () => {
  const r = await get(`/metrics?branch_id=${branch}&from=2026-03-01&to=2026-03-07`);
  a.equal(r.status, 200);
  a.deepEqual(r.body.previous, { from: '2026-02-22', to: '2026-02-28' });
  const s = r.body.sales;
  a.deepEqual(s.totals, {
    cuts: 3,
    sales_cents: '210000',
    card_cents: '90000',
    cash_cents: '120000',
    days: 2,
  });
  a.equal(s.previous.totals.sales_cents, '100000');
  a.equal(s.previous.totals.cuts, 1);
  a.deepEqual(
    s.by_day.map((d: any) => [d.date, d.sales_cents, d.card_cents, d.cuts]),
    [
      ['2026-03-02', '150000', '30000', 2],
      ['2026-03-04', '60000', '60000', 1],
    ],
  );
  a.deepEqual(
    s.previous.by_day.map((d: any) => d.date),
    ['2026-02-25'],
  );
  a.deepEqual(
    s.by_shift.map((x: any) => [x.label, x.cuts, x.sales_cents]),
    [
      ['Mañana', 2, '160000'],
      ['Tarde', 1, '50000'],
    ],
  );
  a.deepEqual(
    s.by_weekday.map((x: any) => [x.weekday, x.days, x.sales_cents]),
    [
      [1, 1, '150000'],
      [3, 1, '60000'],
    ],
  );
  a.deepEqual(
    s.by_register.map((x: any) => [x.register_number, x.cuts, x.sales_cents]),
    [
      [1, 2, '160000'],
      [2, 1, '50000'],
    ],
  );
});

test('métricas de compras: neto, fecha local, anulados y correcciones por persona', async () => {
  const r = await get(`/metrics?branch_id=${branch}&from=2026-03-01&to=2026-03-07`);
  const p = r.body.purchases;
  a.deepEqual(p.totals, {
    tickets: 2,
    gross_cents: '30000',
    corrected_cents: '5000',
    net_cents: '25000',
    voided: 1,
    voided_cents: '7000',
    days: 2,
    corrections: 1,
    corrections_cents: '5000',
  });
  a.deepEqual(
    p.by_day.map((d: any) => [d.date, d.tickets, d.net_cents]),
    [
      ['2026-03-02', 1, '15000'],
      ['2026-03-04', 1, '10000'],
    ],
  );
  a.deepEqual(
    p.by_weekday.map((x: any) => [x.weekday, x.days, x.net_cents]),
    [
      [1, 1, '15000'],
      [3, 1, '10000'],
    ],
  );
  // Abarrotes $300 y Lácteos $80.
  a.equal(p.previous.totals.net_cents, '38000');
  // Empatados en cantidad, se ordenan por nombre.
  a.deepEqual(
    p.by_person.map((x: any) => [
      x.user_id,
      x.voided,
      x.voided_cents,
      x.corrections,
      x.corrections_cents,
    ]),
    [
      [adminId, 0, '0', 1, '5000'],
      [employeeId, 1, '7000', 0, '0'],
    ],
  );
});

test('métricas de proveedores: actual, anterior y última visita', async () => {
  const r = await get(`/metrics?branch_id=${branch}&from=2026-03-01&to=2026-03-07`);
  a.deepEqual(
    r.body.suppliers.map((x: any) => [
      x.company,
      x.product_type,
      x.active,
      x.tickets,
      x.days,
      x.net_cents,
      x.previous_tickets,
      x.previous_days,
      x.previous_net_cents,
      x.last_visit,
    ]),
    [
      ['Abarrotes del Norte', '', true, 2, 2, '25000', 1, 1, '30000', '2026-03-04'],
      ['Lácteos Sierra', 'Lácteos', false, 0, 0, '0', 1, 1, '8000', '2026-02-26'],
    ],
  );
});

test('métricas: un día sin movimientos, permisos y rango', async () => {
  const empty = await get(`/metrics?branch_id=${branch}&from=2026-03-05&to=2026-03-05`);
  a.equal(empty.status, 200);
  a.equal(empty.body.sales.totals.cuts, 0);
  a.equal(empty.body.sales.totals.sales_cents, '0');
  a.equal(empty.body.purchases.totals.net_cents, '0');
  a.deepEqual(empty.body.sales.by_day, []);
  a.equal(
    (await get(`/metrics?branch_id=${branch}&from=2026-03-01&to=2026-03-07`, employeeToken)).status,
    403,
  );
  // Solo administradores y superadministradores.
  a.equal(
    (await get(`/metrics?branch_id=${branch}&from=2026-03-01&to=2026-03-07`, superToken)).status,
    200,
  );
  a.equal((await get(`/metrics?branch_id=${branch}&from=2026-03-07&to=2026-03-01`)).status, 400);
  a.equal((await get(`/metrics?branch_id=${branch}&from=2025-01-01&to=2026-03-01`)).status, 400);
  // Un administrador de esta sucursal no ve otra.
  a.notEqual((await get(`/metrics?branch_id=${other}&from=2026-03-01&to=2026-03-07`)).status, 200);
});
