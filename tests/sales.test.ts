import { test, before, after } from 'node:test';
import { strict as a } from 'node:assert';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { canonical, type Command } from '../packages/domain/index.js';
import { buildXls, sicarFile, sicarRow } from './xls-fixture.js';
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
const { issueSession, issueGrant } = await import('../apps/api/src/security.js');
const { processCommand, commandSchema } = await import('../apps/api/src/commands.js');
const { parseCatalog, publicPrice } = await import('../apps/api/src/sales.js');
const { readXls } = await import('../apps/api/src/xls.js');
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const branch = randomUUID(),
  other = randomUUID(),
  device = randomUUID(),
  pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
let server: ReturnType<typeof app.listen>,
  base: string,
  adminToken: string,
  employeeToken: string,
  otherToken: string,
  employee: any,
  grant: any;
const mime = 'application/vnd.ms-excel';
async function upload(
  file: Buffer,
  mode = 'preview',
  token = adminToken,
  target = branch,
  operation = randomUUID(),
  hash?: string,
) {
  const query = new URLSearchParams({ branch_id: target, mode, operation_id: operation });
  if (hash) query.set('preview_hash', hash);
  const response = await fetch(`${base}/api/v1/products/import?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': mime, Authorization: `Bearer ${token}` },
    body: new Uint8Array(file),
  });
  return { status: response.status, body: await response.json() };
}
async function get(path: string, token = adminToken) {
  const response = await fetch(`${base}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}
function sale(payload: Record<string, string>, issued = grant): Command {
  const c: Command = {
    operation_id: randomUUID(),
    schema_version: 1,
    type: 'sale.create',
    branch_id: branch,
    actor_user_id: employee.id,
    device_id: device,
    grant_id: issued.body.grant_id,
    assignment_epoch: 1,
    device_seq: 0,
    expected_version: '0',
    occurred_at: new Date().toISOString(),
    depends_on: [],
    payload,
  };
  c.signature = sign('sha256', Buffer.from(canonical(c)), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return c;
}
const catalog = () =>
  sicarFile([
    sicarRow('7501055302925', '', 'Coca cola pet 2L', '43.000000'),
    sicarRow('dt', '608890030475', 'Tamix Picositas', '3.703700', { ieps: true }),
    sicarRow('3086123397859', '', 'Encendedor grande', '18.965500', { vat: true }),
    sicarRow('1000', '', 'Aguacate kg', '58.000000', { bulk: true }),
    sicarRow('500', '', 'Bolsa sin precio', '0.000000'),
  ]);
before(async () => {
  await db.connect();
  await db.query('INSERT INTO branches(id,name,register_count) VALUES($1,$2,2),($3,$4,1)', [
    branch,
    'Ventas prueba',
    other,
    'Otra sucursal',
  ]);
  for (const [role, home] of [
    ['admin', branch],
    ['employee', branch],
    ['admin', other],
  ]) {
    const u = (
      await db.query(
        'INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(), `${role}-${randomUUID().slice(0, 8)}`, `Persona ${role}`, role, home],
      )
    ).rows[0];
    const issued = await issueSession(u);
    if (home === other) otherToken = issued.access_token;
    else if (role === 'admin') adminToken = issued.access_token;
    else {
      employeeToken = issued.access_token;
      employee = u;
    }
  }
  await db.query('INSERT INTO devices VALUES($1,$2,$3,$4,true)', [
    device,
    branch,
    'Caja de prueba',
    pair.publicKey.export({ format: 'jwk' }),
  ]);
  grant = await issueGrant(employee, device, pair.publicKey.export({ format: 'jwk' }), 1);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await db.end();
});

test('lector .xls: textos partidos entre registros, acentos, números y archivos inválidos', () => {
  const long = 'Descripción larga '.repeat(12).trim(),
    rows = [
      ['CLAVE', 'DESCRIPCION', 'PRECIO 1'],
      ['010248765104', long, '9.000000'],
      ['ñandú', 'Café «especial» 日本', 12.5],
      ['7', long, 3],
    ];
  // Tiny records force the shared strings to continue in the middle of a text.
  for (const limit of [8224, 64, 21]) a.deepEqual(readXls(buildXls(rows, limit)), rows);
  a.throws(() => readXls(Buffer.from('PK\u0003\u0004 no es xls')), /SICAR/);
  const broken = buildXls(rows);
  a.throws(() => readXls(broken.subarray(0, 2000)), { code: 'INVALID_EXCEL' });
  broken.writeInt32LE(5_000_000, 76);
  a.throws(() => readXls(broken), { code: 'INVALID_EXCEL' });
});

test('precio al público: suma IEPS 8% e IVA 16% y redondea a centavos', () => {
  const price = (base: bigint, vat: boolean, ieps: boolean) => publicPrice(base, vat, ieps).cents;
  a.equal(price(3_703_700n, false, true), 400n);
  a.equal(price(18_965_500n, true, false), 2200n);
  a.equal(price(58_000_000n, false, false), 5800n);
  a.equal(price(10_000_000n, true, true), 1253n);
  a.equal(publicPrice(17_592_600n, false, false).uneven, true);
  a.equal(publicPrice(17_500_000n, false, false).uneven, false);
});

test('catálogo SICAR: solo se toman clave, clave alterna, descripción, precio 1 y granel', () => {
  const parsed = parseCatalog(
    sicarFile([
      ...[
        sicarRow('dt', '608890030475', '  Tamix   Picositas ', '3.703700', { ieps: true }),
        sicarRow('1000', '1000', 'Aguacate kg', '58.000000', { bulk: true }),
        sicarRow('500', '', 'Sin precio', '0.000000'),
      ],
      sicarRow('', '', 'Sin clave', '5.000000'),
      sicarRow('DT', '', 'Clave repetida', '5.000000'),
      sicarRow('8', '', '', '5.000000'),
      sicarRow('9', '', 'Precio malo', 'gratis'),
    ]),
  );
  a.deepEqual(parsed.products, [
    {
      clave: 'dt',
      clave_alterna: '608890030475',
      description: 'Tamix Picositas',
      price_cents: '400',
      bulk: false,
    },
    {
      clave: '1000',
      clave_alterna: '',
      description: 'Aguacate kg',
      price_cents: '5800',
      bulk: true,
    },
    { clave: '500', clave_alterna: '', description: 'Sin precio', price_cents: '0', bulk: false },
  ]);
  a.equal(parsed.unpriced, 1);
  a.deepEqual(
    parsed.invalid.map((i) => i.row),
    [5, 6, 7, 8],
  );
  a.throws(
    () =>
      parseCatalog(
        buildXls([
          ['CLAVE', 'DESCRIPCION'],
          ['1', 'x'],
        ]),
      ),
    {
      code: 'INVALID_HEADERS',
    },
  );
});

test('importación: vista previa sin guardar, permisos, confirmación idempotente y reemplazo', async () => {
  const file = catalog();
  a.equal((await upload(file, 'preview', employeeToken)).status, 403);
  a.equal((await upload(file, 'preview', otherToken)).status, 403);
  const reviewed = await upload(file);
  a.equal(reviewed.status, 200);
  a.deepEqual(reviewed.body.summary, {
    total: 5,
    new: 5,
    changed: 0,
    unchanged: 0,
    removed: 0,
    bulk: 1,
    unpriced: 1,
    uneven: 0,
    invalid: 0,
  });
  const stored = async () =>
    (
      await db.query(
        'SELECT clave,price_cents::int AS price,bulk,active FROM products WHERE branch_id=$1 ORDER BY clave',
        [branch],
      )
    ).rows;
  a.equal((await stored()).length, 0);
  a.equal(
    (await upload(file, 'confirm', adminToken, branch, randomUUID(), 'x'.repeat(64))).status,
    400,
  );
  const operation = randomUUID();
  const saved = await Promise.all([
    upload(file, 'confirm', adminToken, branch, operation, reviewed.body.preview_hash),
    upload(file, 'confirm', adminToken, branch, operation, reviewed.body.preview_hash),
  ]);
  for (const r of saved) a.equal(r.status, 200);
  a.deepEqual(await stored(), [
    { clave: '1000', price: 5800, bulk: true, active: true },
    { clave: '3086123397859', price: 2200, bulk: false, active: true },
    { clave: '500', price: 0, bulk: false, active: true },
    { clave: '7501055302925', price: 4300, bulk: false, active: true },
    { clave: 'dt', price: 400, bulk: false, active: true },
  ]);
  const first = await get(`/products?branch_id=${branch}`, employeeToken);
  a.equal(first.body.version, 1);
  a.equal(first.body.products.length, 5);
  a.deepEqual(first.body.products.find((p: any[]) => p[1] === 'dt').slice(1), [
    'dt',
    '608890030475',
    'Tamix Picositas',
    400,
    0,
  ]);
  a.deepEqual((await get(`/products?branch_id=${branch}&version=1`, employeeToken)).body, {
    version: 1,
    unchanged: true,
  });
  // Another branch has its own catalog and never sees this one.
  a.deepEqual((await get(`/products?branch_id=${other}`, otherToken)).body.products, []);
  a.equal((await get(`/products?branch_id=${branch}`, otherToken)).status, 403);
  // A new export changes a price, drops a product and brings a new one.
  const next = sicarFile([
    sicarRow('7501055302925', '', 'Coca cola pet 2L', '45.000000'),
    sicarRow('DT', '608890030475', 'Tamix Picositas', '3.703700', { ieps: true }),
    sicarRow('3086123397859', '', 'Encendedor grande', '18.965500', { vat: true }),
    sicarRow('1000', '', 'Aguacate kg', '58.000000', { bulk: true }),
    sicarRow('1030', '', 'Huevo kg', '45.000000', { bulk: true }),
  ]);
  const second = await upload(next);
  a.deepEqual(
    [second.body.summary.new, second.body.summary.changed, second.body.summary.removed],
    [1, 2, 1],
  );
  a.equal(
    (await upload(next, 'confirm', adminToken, branch, randomUUID(), second.body.preview_hash))
      .status,
    200,
  );
  const after = await stored();
  a.deepEqual(
    after.find((p) => p.clave === '500'),
    { clave: '500', price: 0, bulk: false, active: false },
  );
  a.equal(after.find((p) => p.clave === '7501055302925').price, 4500);
  a.equal(after.length, 6);
  const latest = await get(`/products?branch_id=${branch}&version=1`, employeeToken);
  a.equal(latest.body.version, 2);
  a.equal(latest.body.products.length, 5);
  a.ok(!latest.body.products.some((p: any[]) => p[1] === '500'));
  a.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM audit_events WHERE branch_id=$1 AND action='products.import'",
        [branch],
      )
    ).rows[0].n,
    2,
  );
});

test('venta: se guarda con sus renglones, valida totales y pago, y no se duplica', async () => {
  const products = new Map<string, any>(
    (
      await db.query('SELECT id,clave,price_cents::int AS price FROM products WHERE branch_id=$1', [
        branch,
      ])
    ).rows.map((r) => [r.clave, r]),
  );
  const coke = products.get('7501055302925'),
    avocado = products.get('1000'),
    retired = products.get('500');
  const items = JSON.stringify([
    [coke.id, 2000, coke.price],
    [avocado.id, 750, avocado.price],
  ]);
  // 2 x $45.00 + 0.750 kg x $58.00 = $133.50
  const payload = {
    id: randomUUID(),
    register_number: '1',
    payment: 'cash',
    total_cents: '13350',
    received_cents: '20000',
    items,
  };
  a.ok(grant.body.allowed_commands.includes('sale.create'));
  const command = sale(payload);
  commandSchema.parse(command);
  const result = await processCommand(command, device);
  a.equal(result.status, 'confirmed');
  a.deepEqual(await processCommand(command, device), result);
  const stored = (
    await db.query(
      'SELECT user_id,register_number,payment,total_cents::int,received_cents::int,change_cents::int FROM sales WHERE branch_id=$1',
      [branch],
    )
  ).rows;
  a.deepEqual(stored, [
    {
      user_id: employee.id,
      register_number: 1,
      payment: 'cash',
      total_cents: 13350,
      received_cents: 20000,
      change_cents: 6650,
    },
  ]);
  a.deepEqual(
    (
      await db.query(
        'SELECT line,clave,description,quantity_milli::int,unit_price_cents::int,total_cents::int FROM sale_items WHERE branch_id=$1 ORDER BY line',
        [branch],
      )
    ).rows,
    [
      {
        line: 1,
        clave: '7501055302925',
        description: 'Coca cola pet 2L',
        quantity_milli: 2000,
        unit_price_cents: 4500,
        total_cents: 9000,
      },
      {
        line: 2,
        clave: '1000',
        description: 'Aguacate kg',
        quantity_milli: 750,
        unit_price_cents: 5800,
        total_cents: 4350,
      },
    ],
  );
  // Sales are informative: the money reaches Caja general only through the cut.
  a.equal(
    (await db.query('SELECT count(*)::int n FROM treasury_entries WHERE branch_id=$1', [branch]))
      .rows[0].n,
    0,
  );
  const rejected = async (changes: Record<string, string>, code: RegExp | string) =>
    a.rejects(
      () => processCommand(sale({ ...payload, id: randomUUID(), ...changes }), device),
      typeof code === 'string' ? { code } : code,
    );
  await rejected({ total_cents: '13000', received_cents: '13000' }, 'INVALID_SALE');
  await rejected({ received_cents: '13349' }, 'INVALID_SALE');
  await rejected({ payment: 'card', received_cents: '20000' }, 'INVALID_SALE');
  await rejected({ register_number: '2' }, 'FORBIDDEN');
  await rejected({ items: '[]' }, /./);
  await rejected({ items: 'no es json' }, 'INVALID_SALE');
  await rejected(
    {
      items: JSON.stringify([[randomUUID(), 1000, 100]]),
      total_cents: '100',
      received_cents: '100',
    },
    'NOT_FOUND',
  );
  await rejected(
    { items: JSON.stringify([[coke.id, 1000, 0]]), total_cents: '0', received_cents: '0' },
    /./,
  );
  // A product retired by a later import can still close a sale that was captured offline before.
  const card = sale({
    id: randomUUID(),
    register_number: '1',
    payment: 'card',
    total_cents: '1500',
    received_cents: '1500',
    items: JSON.stringify([[retired.id, 1000, 1500]]),
  });
  a.equal((await processCommand(card, device)).status, 'confirmed');
  a.equal(
    (await db.query('SELECT count(*)::int n FROM sales WHERE branch_id=$1', [branch])).rows[0].n,
    2,
  );
});

test('consulta: el cajero recibe sus ventas del turno y el administrador el detalle del día', async () => {
  const snapshot = await get(`/snapshot?branch_id=${branch}`, employeeToken);
  a.equal(snapshot.status, 200);
  a.equal(snapshot.body.catalog.version, 2);
  a.equal(snapshot.body.catalog.product_count, 5);
  a.deepEqual(
    snapshot.body.sales.map((s: any) => [s.payment, s.total_cents, s.register_number]),
    [
      ['cash', '13350', 1],
      ['card', '1500', 1],
    ],
  );
  const mine = await get(`/snapshot?branch_id=${branch}`, adminToken);
  a.deepEqual(mine.body.sales, []);
  const zone = (await db.query('SELECT timezone FROM branches WHERE id=$1', [branch])).rows[0]
    .timezone;
  const { shiftBusinessDate } = await import('../packages/domain/index.js');
  const today = shiftBusinessDate(new Date(), zone);
  a.equal((await get(`/sales?branch_id=${branch}&date=${today}`, employeeToken)).status, 403);
  a.equal((await get(`/sales?branch_id=${branch}&date=${today}`, otherToken)).status, 403);
  const day = await get(`/sales?branch_id=${branch}&date=${today}`);
  a.equal(day.status, 200);
  a.equal(day.body.sales.length, 2);
  a.equal(day.body.sales[0].user_name, 'Persona employee');
  a.deepEqual(
    day.body.sales[0].items.map((i: any) => [i.clave, i.quantity_milli, i.total_cents]),
    [
      ['7501055302925', 2000, '9000'],
      ['1000', 750, '4350'],
    ],
  );
  a.deepEqual((await get(`/sales?branch_id=${branch}&date=2020-01-01`)).body.sales, []);
  a.deepEqual((await get(`/sales?branch_id=${other}&date=${today}`, otherToken)).body.sales, []);
});
