import { test, before, after } from 'node:test';
import { strict as a } from 'node:assert';
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import { SMTPServer } from 'smtp-server';
import pg from 'pg';
import { canonical, localTime, type Command } from '../packages/domain/index.js';
if (process.env.NODE_ENV === 'production' || !process.env.MIGRATION_DATABASE_URL)
  throw Error('Las pruebas requieren la base local de desarrollo.');
process.env.NODE_ENV = 'test';
const { app } = await import('../apps/api/src/server.js');
const { pool, transaction } = await import('../apps/api/src/db.js');
const { processCommand } = await import('../apps/api/src/commands.js');
const { issueGrant, issueSession, validateCommand } = await import('../apps/api/src/security.js');
const sql = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let server: ReturnType<typeof app.listen>,
  base: string,
  branch: string,
  other: string,
  device: string,
  employee: any,
  second: any,
  ownerToken: string,
  employeeToken: string,
  adminToken: string,
  grant: any;
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
let seq = 0,
  version = 0;
async function call(path: string, body?: unknown, token = ownerToken) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function token(username: string) {
  const { status, body } = await call(
    '/auth/login',
    { username, password: 'ShiftTrack-demo-2026!' },
    '',
  );
  a.equal(status, 200);
  a.match(body.access_token, /^[A-Za-z0-9_-]{43}$/);
  a.ok(body.expires_at);
  return body.access_token as string;
}

function command(
  type: Command['type'],
  payload: Record<string, string>,
  actor = employee,
  issued = grant,
  instant = new Date().toISOString(),
): Command {
  const c: Command = {
    operation_id: randomUUID(),
    schema_version: 1,
    type,
    branch_id: branch,
    actor_user_id: actor.id,
    device_id: device,
    grant_id: issued.body.grant_id,
    assignment_epoch: 1,
    device_seq: type.startsWith('supplier.') ? seq + 1 : 0,
    expected_version: String(version),
    occurred_at: instant,
    depends_on: [],
    payload,
  };
  c.signature = sign('sha256', Buffer.from(canonical(c)), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return c;
}
async function apply(c: Command) {
  const result = await processCommand(c, device);
  if (c.type.startsWith('supplier.')) {
    seq = c.device_seq;
    version = Number(result.version);
  }
  return result;
}
before(async () => {
  await sql.connect();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  ownerToken = await token('cesar');
  employeeToken = await token('ana');
  adminToken = await token('admin');
  branch = randomUUID();
  other = randomUUID();
  device = randomUUID();
  await sql.query('INSERT INTO branches(id,name) VALUES($1,$2),($3,$4)', [
    branch,
    `Prueba ${branch}`,
    other,
    `Otra ${other}`,
  ]);
  const hash = (
    await sql.query(
      "SELECT p.hash FROM password_credentials p JOIN users u ON u.id=p.user_id WHERE username='ana'",
    )
  ).rows[0].hash;
  for (const index of [0, 1]) {
    const id = randomUUID();
    const user = (
      await sql.query(
        "INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,$3,'employee',$4) RETURNING *",
        [id, `test-${id}`, `Empleado ${index}`, branch],
      )
    ).rows[0];
    await sql.query('INSERT INTO password_credentials VALUES($1,$2)', [id, hash]);
    if (index === 0) employee = user;
    else second = user;
  }
  await sql.query('INSERT INTO devices VALUES($1,$2,$3,$4,true)', [
    device,
    branch,
    'Equipo de prueba',
    pair.publicKey.export({ format: 'jwk' }),
  ]);
  await sql.query('UPDATE branches SET device_id=$2 WHERE id=$1', [branch, device]);
  grant = await issueGrant(employee, device, pair.publicKey.export({ format: 'jwk' }));
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await sql.end();
  await pool.end();
});
test('sesión propia y ámbito de sucursal; RLS sin contexto no filtra datos ajenos', async () => {
  a.equal((await call(`/snapshot?branch_id=${branch}`, undefined, employeeToken)).status, 403);
  a.equal((await call(`/snapshot?branch_id=${branch}`, undefined, adminToken)).status, 403);
  a.equal((await pool.query('SELECT * FROM treasury_entries')).rowCount, 0);
  a.equal(
    (
      await call(
        '/users',
        {
          branch_id: branch,
          role: 'admin',
          username: 'intruso',
          name: 'Intruso',
          password: 'No-permitido-123',
        },
        employeeToken,
      )
    ).status,
    403,
  );
  a.equal((await call('/branches', { name: 'Prohibida' }, adminToken)).status, 403);
});
test('sesiones opacas: hash en SQL, vencimiento, cierre individual y credenciales genéricas', async () => {
  const id = randomUUID(),
    username = `session-${id}`;
  const hash = (
    await sql.query(
      "SELECT hash FROM password_credentials WHERE user_id=(SELECT id FROM users WHERE username='ana')",
    )
  ).rows[0].hash;
  await sql.query(
    "INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,'Sesiones','employee',$3)",
    [id, username, branch],
  );
  await sql.query('INSERT INTO password_credentials VALUES($1,$2)', [id, hash]);
  const login = await call('/auth/login', { username, password: 'ShiftTrack-demo-2026!' }, '');
  const first = login.body.access_token,
    second = await token(username);
  a.equal(login.status, 200);
  const row = (
    await sql.query('SELECT * FROM auth_sessions WHERE token_hash=$1', [
      createHash('sha256').update(first).digest('hex'),
    ])
  ).rows[0];
  a.equal(row.user_id, id);
  a.equal(+row.expires_at - +row.issued_at, 8 * 3600_000);
  a.notEqual(row.token_hash, first);
  a.equal((await call('/auth/me', undefined, first)).body.id, id);
  a.equal((await call('/auth/logout', {}, first)).status, 200);
  a.equal((await call('/auth/me', undefined, first)).status, 401);
  a.equal((await call('/auth/me', undefined, second)).status, 200);
  await sql.query(
    "UPDATE auth_sessions SET issued_at=now()-interval '9 hours',expires_at=now()-interval '1 hour' WHERE token_hash=$1",
    [createHash('sha256').update(second).digest('hex')],
  );
  a.equal((await call('/auth/me', undefined, second)).status, 401);
  a.equal((await call('/auth/me', undefined, randomUUID())).status, 401);
  const wrong = await call('/auth/login', { username, password: 'incorrecta' }, '');
  const unknown = await call(
    '/auth/login',
    { username: `absent-${id}`, password: 'incorrecta' },
    '',
  );
  a.equal(wrong.status, 401);
  a.deepEqual(wrong.body, unknown.body);
});
test('cambiar contraseña revoca todas las sesiones y conserva concesiones para revisión', async () => {
  const id = randomUUID(),
    username = `password-${id}`;
  const hash = (
    await sql.query(
      "SELECT hash FROM password_credentials WHERE user_id=(SELECT id FROM users WHERE username='ana')",
    )
  ).rows[0].hash;
  const user = (
    await sql.query(
      "INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,'Cambio contraseña','employee',$3) RETURNING *",
      [id, username, branch],
    )
  ).rows[0];
  await sql.query('INSERT INTO password_credentials VALUES($1,$2)', [id, hash]);
  const first = await token(username),
    second = await token(username);
  const localGrant = await issueGrant(user, device, pair.publicKey.export({ format: 'jwk' }));
  const pending = command(
    'shortage.create',
    { id: randomUUID(), description: 'Pendiente', amount_cents: '100' },
    user,
    localGrant,
  );
  a.equal(
    (
      await call(
        '/auth/change-password',
        { old_password: 'incorrecta', password: 'Nueva-contrasena-2026!' },
        first,
      )
    ).status,
    401,
  );
  a.equal((await call('/auth/me', undefined, second)).status, 200);
  a.equal(
    (
      await call(
        '/auth/change-password',
        { old_password: 'ShiftTrack-demo-2026!', password: 'Nueva-contrasena-2026!' },
        first,
      )
    ).status,
    200,
  );
  a.equal((await call('/auth/me', undefined, first)).status, 401);
  a.equal((await call('/auth/me', undefined, second)).status, 401);
  a.equal((await sql.query('SELECT 1 FROM auth_sessions WHERE user_id=$1', [id])).rowCount, 0);
  a.equal(
    (await call('/auth/login', { username, password: 'ShiftTrack-demo-2026!' }, '')).status,
    401,
  );
  const fresh = await call('/auth/login', { username, password: 'Nueva-contrasena-2026!' }, '');
  a.equal(fresh.status, 200);
  a.equal((await call('/auth/me', undefined, fresh.body.access_token)).status, 200);
  await a.rejects(validateCommand(pending, device), (e: any) => e.code === 'REQUIRES_ADMIN_REVIEW');
  a.equal(
    (await sql.query('SELECT 1 FROM grants WHERE id=$1', [localGrant.body.grant_id])).rowCount,
    1,
  );
  await sql.query('UPDATE users SET active=false,auth_version=auth_version+1 WHERE id=$1', [id]);
  a.equal((await call('/auth/me', undefined, fresh.body.access_token)).status, 401);
  await a.rejects(issueSession(user), (e: any) => e.code === 'UNAUTHENTICATED');
});
test('apertura incluye proveedores una sola vez y no permite reinicializar', async () => {
  a.equal(
    (
      await call('/treasury/opening', {
        branch_id: branch,
        cash_cents: '1000000',
        bank_cents: '500000',
        supplier_cents: '200000',
      })
    ).status,
    200,
  );
  a.equal(
    (
      await call('/treasury/opening', {
        branch_id: branch,
        cash_cents: '1000000',
        bank_cents: '500000',
        supplier_cents: '200000',
      })
    ).status,
    409,
  );
  const totals = await transaction(
    branch,
    async (db) =>
      (await db.query('SELECT sum(cash_cents) cash,sum(bank_cents) bank FROM treasury_entries'))
        .rows[0],
  );
  a.equal(totals.cash, '1000000');
  a.equal(totals.bank, '500000');
});
const supplier = randomUUID(),
  shift = randomUUID(),
  ticket = randomUUID();
test('pago concurrente reenviado 100 veces produce un solo efecto y adición es traslado interno', async () => {
  await apply(command('supplier.create', { id: supplier, company: 'Proveedor prueba' }));
  await apply(command('supplier.shift.open', { id: shift, previous_close_id: '' }));
  await apply(command('supplier.balance.add', { amount_cents: '50000' }));
  const c = command('supplier.ticket.create', {
    id: ticket,
    supplier_id: supplier,
    amount_cents: '30000',
  });
  const results = await Promise.all(Array.from({ length: 100 }, () => processCommand(c, device)));
  seq = c.device_seq;
  version = Number(results[0].version);
  a.ok(results.every((x) => x.operation_id === c.operation_id));
  const rows = await transaction(branch, async (db) => ({
    tickets: (await db.query('SELECT * FROM tickets')).rows,
    entries: (await db.query('SELECT * FROM treasury_entries')).rows,
  }));
  a.equal(rows.tickets.length, 1);
  a.equal(
    rows.entries.reduce((s, t) => s + BigInt(t.cash_cents), 0n),
    970000n,
  );
  a.equal(
    (await sql.query('SELECT balance_cents FROM branches WHERE id=$1', [branch])).rows[0]
      .balance_cents,
    '220000',
  );
  const changed = { ...c, payload: { ...c.payload, amount_cents: '999' } };
  const { signature: _, ...body } = changed;
  changed.signature = sign('sha256', Buffer.from(canonical(body)), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  await a.rejects(() => processCommand(changed, device), { code: 'VERSION_CONFLICT' });
});
test('cierre contado y relevo conservan dinero y autoría', async () => {
  await apply(command('supplier.shift.close', { counted_cents: '219000' }));
  const newGrant = await issueGrant(second, device, pair.publicKey.export({ format: 'jwk' }));
  await apply(
    command(
      'supplier.shift.open',
      { id: randomUUID(), previous_close_id: shift },
      second,
      newGrant,
    ),
  );
  const state = (
    await sql.query('SELECT * FROM supplier_shifts WHERE branch_id=$1 ORDER BY opened_at', [branch])
  ).rows;
  a.equal(state[0].difference_cents, '-1000');
  a.equal(state[1].opening_cents, '219000');
  a.equal(state[1].actor_user_id, second.id);
  await a.rejects(
    () => apply(command('supplier.ticket.void', { id: ticket, reason: 'Después del cierre' })),
    { code: 'FORBIDDEN' },
  );
  // Leave the stream closed for subsequent independent tests.
  await apply(command('supplier.shift.close', { counted_cents: '219000' }, second, newGrant));
});
test('ficha previa, corte único y contado de ventas alimentan general', async () => {
  const date = localTimeForTest();
  await sql.query(
    'INSERT INTO clock_records(branch_id,id,user_id,business_date,clock_in) VALUES($1,$2,$3,$4,now())',
    [branch, randomUUID(), employee.id, date],
  );
  const c = command('cut.create', {
    id: randomUUID(),
    sales_cents: '100000',
    card_cents: '20000',
    declared_cents: '79000',
    register_number: '1',
  });
  await apply(c);
  await apply(c);
  await a.rejects(
    () => apply(command('cut.create', { ...c.payload, id: randomUUID() })),
    (e: any) => e.code === '23505',
  );
  const total = await transaction(
    branch,
    async (db) =>
      (await db.query('SELECT sum(cash_cents) cash,sum(bank_cents) bank FROM treasury_entries'))
        .rows[0],
  );
  a.equal(total.cash, '1049000');
  a.equal(total.bank, '520000');
});
function localTimeForTest() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mazatlan',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
test('equipo erróneo, firma alterada y concesión vencida bloquean capturas', async () => {
  const c = command('shortage.create', { id: randomUUID(), product: 'Agua' });
  await a.rejects(() => processCommand(c, randomUUID()), { code: 'FORBIDDEN' });
  await a.rejects(
    () => processCommand({ ...c, payload: { ...c.payload, product: 'Alterado' } }, device),
    { code: 'FORBIDDEN' },
  );
  const past = await issueGrant(employee, device, pair.publicKey.export({ format: 'jwk' }));
  await sql.query(
    "UPDATE grants SET issued_at=now()-interval '9 hours',expires_at=now()-interval '1 hour' WHERE id=$1",
    [past.body.grant_id],
  );
  await a.rejects(
    () =>
      apply(command('shortage.create', { id: randomUUID(), product: 'Vencida' }, employee, past)),
    { code: 'REQUIRES_ADMIN_REVIEW' },
  );
  // Expiration at reception does not erase an earlier capture inside its valid window.
  const captured = new Date(Date.now() - 2 * 3600_000).toISOString();
  await apply(
    command(
      'shortage.create',
      { id: randomUUID(), product: 'Captura anterior válida' },
      employee,
      past,
      captured,
    ),
  );
});
async function transport() {
  const challenge = (await call('/devices/challenge', { device_id: device }, '')).body;
  const signature = sign('sha256', Buffer.from(canonical(challenge)), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return (await call('/devices/session', { id: challenge.id, signature }, '')).body.token;
}
async function deviceCall(path: string, body: unknown, token: string) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Device ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
test('correcciones esperan equipo pausado; original y contado permanecen intactos', async () => {
  const pause = (await call('/supplier-corrections/prepare', { branch_id: branch })).body;
  const data = {
    branch_id: branch,
    ticket_id: ticket,
    type: 'documentary',
    amount_cents: '1000',
    reason: 'Rectificación documental de prueba',
    pause_token: pause.pause_token,
  };
  a.equal((await call('/supplier-corrections', data)).status, 409);
  const state = (await sql.query('SELECT * FROM branches WHERE id=$1', [branch])).rows[0];
  const token = await transport();
  a.equal(
    (
      await deviceCall(
        '/devices/pause-ack',
        { pause_token: pause.pause_token, version: state.version, device_seq: state.device_seq },
        token,
      )
    ).status,
    200,
  );
  await a.rejects(() => apply(command('supplier.balance.add', { amount_cents: '100' })), {
    code: 'BOX_PAUSED',
  });
  a.equal((await call('/supplier-corrections', data)).status, 200);
  version++;
  a.equal(
    (await sql.query('SELECT balance_cents FROM branches WHERE id=$1', [branch])).rows[0]
      .balance_cents,
    '219000',
  );
  const next = (await call('/supplier-corrections/prepare', { branch_id: branch })).body;
  a.equal(
    (
      await deviceCall(
        '/devices/pause-ack',
        { pause_token: next.pause_token, version: String(version), device_seq: String(seq) },
        token,
      )
    ).status,
    200,
  );
  a.equal(
    (
      await call('/supplier-corrections', {
        ...data,
        pause_token: next.pause_token,
        type: 'refund',
        amount_cents: '2000',
        reason: 'Devolución física de prueba',
      })
    ).status,
    200,
  );
  version++;
  a.equal(
    (await sql.query('SELECT balance_cents FROM branches WHERE id=$1', [branch])).rows[0]
      .balance_cents,
    '221000',
  );
  a.equal(
    (await sql.query('SELECT amount_cents FROM tickets WHERE id=$1', [ticket])).rows[0]
      .amount_cents,
    '30000',
  );
  a.equal(
    (await sql.query('SELECT counted_cents FROM supplier_shifts WHERE id=$1', [shift])).rows[0]
      .counted_cents,
    '219000',
  );
});
test('turno del día anterior exige conteo antes de permitir pagos', async () => {
  const yesterday = localTime(new Date(Date.now() - 86400000), 'America/Mazatlan').date,
    id = randomUUID();
  await sql.query(
    "INSERT INTO supplier_shifts(branch_id,id,actor_user_id,business_date,opened_at,opening_cents) VALUES($1,$2,$3,$4,now()-interval '1 day',221000)",
    [branch, id, employee.id, yesterday],
  );
  await sql.query('UPDATE branches SET active_shift=$2 WHERE id=$1', [branch, id]);
  await a.rejects(() => apply(command('supplier.balance.add', { amount_cents: '100' })), {
    code: 'PREVIOUS_SHIFT_UNCLOSED',
  });
  await apply(command('supplier.shift.reconcile', { counted_cents: '220000' }));
  a.equal(
    (await sql.query('SELECT difference_cents FROM supplier_shifts WHERE id=$1', [id])).rows[0]
      .difference_cents,
    '-1000',
  );
});
test('tareas recurrentes se generan una sola vez, fotografías privadas y Excel real', async () => {
  const date = localTimeForTest();
  a.equal(
    (await call('/tasks/catalog', { branch_id: branch, title: 'Aseo diario', priority: 'normal' }))
      .status,
    201,
  );
  const template = (await sql.query('SELECT id FROM task_catalog WHERE branch_id=$1', [branch]))
    .rows[0].id;
  a.equal(
    (
      await call('/tasks/assignments', {
        branch_id: branch,
        catalog_id: template,
        user_id: employee.id,
        recurrence: 'daily',
        start_date: date,
      })
    ).status,
    201,
  );
  const { generateTasks } = await import('../apps/api/src/modules.js');
  await transaction(branch, async (db) => {
    await generateTasks(db, branch, date);
    await generateTasks(db, branch, date);
  });
  const tasks = (await sql.query('SELECT * FROM tasks WHERE branch_id=$1', [branch])).rows;
  a.equal(tasks.length, 1);
  const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#059669' } })
    .png()
    .toBuffer();
  const c = command('task.complete', {
    id: tasks[0].id,
    note: 'Con fotografía',
    media_id: randomUUID(),
    media_hash: createHash('sha256').update(photo).digest('hex'),
  });
  await a.rejects(() => apply(c), { code: 'DEPENDENCY_PENDING' });
  const deviceToken = await transport();
  a.equal(
    (
      await deviceCall(
        '/media/upload',
        { command: c, base64: photo.toString('base64') },
        deviceToken,
      )
    ).status,
    200,
  );
  await apply(c);
  const evidence = await fetch(
    `${base}/api/v1/media/${c.payload.media_id}/content?branch_id=${branch}`,
    { headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  a.equal(evidence.status, 200);
  a.equal(evidence.headers.get('content-type'), 'image/png');
  a.deepEqual(Buffer.from(await evidence.arrayBuffer()), photo);
  a.equal(
    (
      await fetch(`${base}/api/v1/media/${c.payload.media_id}/content?branch_id=${other}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
    ).status,
    404,
  );
  a.equal(
    (
      await fetch(`${base}/api/v1/media/${c.payload.media_id}/content?branch_id=${branch}`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      })
    ).status,
    403,
  );
  const report = await fetch(`${base}/api/v1/reports/export?branch_id=${branch}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  a.equal(report.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await report.arrayBuffer()) as any);
  a.equal(book.getWorksheet('Tickets')!.rowCount, 2);
  a.equal(book.getWorksheet('Tareas')!.rowCount, 2);
  const analytics = (await call(`/analytics?branch_id=${branch}`)).body;
  a.equal(analytics.spending.find((s: any) => s.id === supplier).net_cents, '27000');
  a.equal(analytics.baselines[0].average_cents, '100000');
  a.equal((await call(`/analytics?branch_id=${branch}`, undefined, employeeToken)).status, 403);
});
test('gasto y retiro bancario online tienen efecto único al repetir el identificador', async () => {
  const before = (
    await sql.query(
      'SELECT sum(cash_cents)::text cash,sum(bank_cents)::text bank FROM treasury_entries WHERE branch_id=$1',
      [branch],
    )
  ).rows[0];
  const id = randomUUID(),
    withdrawal = {
      branch_id: branch,
      operation_id: id,
      kind: 'bank_withdrawal',
      amount_cents: '50000',
      note: 'Retiro a efectivo',
    };
  const replies = await Promise.all(
    Array.from({ length: 10 }, () => call('/treasury/movements', withdrawal)),
  );
  a.ok(replies.every((x) => x.status === 201));
  const expense = {
    ...withdrawal,
    operation_id: randomUUID(),
    kind: 'expense',
    amount_cents: '10000',
    note: 'Gasto independiente',
  };
  a.equal((await call('/treasury/movements', expense)).status, 201);
  a.equal((await call('/treasury/movements', expense)).status, 201);
  a.equal(
    (await call('/treasury/movements', { ...withdrawal, amount_cents: '60000' })).status,
    409,
  );
  const after = (
    await sql.query(
      'SELECT sum(cash_cents)::text cash,sum(bank_cents)::text bank FROM treasury_entries WHERE branch_id=$1',
      [branch],
    )
  ).rows[0];
  a.equal(BigInt(after.cash) - BigInt(before.cash), 40000n);
  a.equal(BigInt(after.bank) - BigInt(before.bank), -50000n);
});
test('administrador no crea otro administrador y último dueño queda protegido', async () => {
  const branchAdmin = (await call('/auth/me', undefined, adminToken)).body;
  a.equal(
    (
      await call(
        '/users',
        {
          branch_id: branchAdmin.branch_id,
          role: 'admin',
          username: `bad-${randomUUID()}`,
          name: 'No permitido',
          password: 'No-permitido-123',
        },
        adminToken,
      )
    ).status,
    403,
  );
  const owner = (await call('/auth/me')).body;
  a.equal((await call(`/users/${owner.id}/deactivate`, { branch_id: branch })).status, 409);
});
test('otro equipo permite tareas y cortes, pero nunca proveedores en paralelo', async () => {
  const support = randomUUID();
  const body = {
    id: support,
    branch_id: branch,
    name: 'Equipo secundario',
    public_key: pair.publicKey.export({ format: 'jwk' }),
    supplier_register: 2,
  };
  a.equal((await call('/devices/register', body)).status, 409);
  a.equal((await call('/devices/register', { ...body, supplier_enabled: false })).status, 201);
  a.equal(
    (await sql.query('SELECT device_id FROM branches WHERE id=$1', [branch])).rows[0].device_id,
    device,
  );
  const localGrant = await issueGrant(employee, support, pair.publicKey.export({ format: 'jwk' }));
  a.ok(localGrant.body.allowed_commands.includes('cut.create'));
  a.ok(!localGrant.body.allowed_commands.some((x) => x.startsWith('supplier.')));
  function inSupport(c: Command) {
    const { signature: _, ...unsigned } = c;
    const changed = { ...unsigned, device_id: support };
    return {
      ...changed,
      signature: sign('sha256', Buffer.from(canonical(changed)), {
        key: pair.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64'),
    };
  }
  await processCommand(
    inSupport(
      command(
        'shortage.create',
        { id: randomUUID(), product: 'Equipo secundario' },
        employee,
        localGrant,
      ),
    ),
    support,
  );
  await a.rejects(
    () =>
      processCommand(
        inSupport(
          command(
            'supplier.create',
            { id: randomUUID(), company: 'No autorizado' },
            employee,
            localGrant,
          ),
        ),
        support,
      ),
    { code: 'FORBIDDEN' },
  );
});
test('worker genera avisos y correo con deduplicación; entrega incierta requiere revisión', async () => {
  let received = 0;
  const smtpServer = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, callback) {
      stream.on('data', () => {});
      stream.on('end', () => {
        received++;
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve));
  const old = {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    from: process.env.SMTP_FROM,
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
  };
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String((smtpServer.server.address() as any).port);
  process.env.SMTP_FROM = 'demo@shifttrack.invalid';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  try {
    a.equal(
      (
        await call('/alerts/settings', {
          branch_id: branch,
          absence_tolerance_minutes: 15,
          cut_delay_minutes: 30,
          recipients: ['recipient@shifttrack.invalid'],
          email_enabled: true,
        })
      ).status,
      200,
    );
    await sql.query(
      'INSERT INTO schedules(branch_id,id,user_id,business_date,start_time,end_time) VALUES($1,$2,$3,$4,$5,$6)',
      [branch, randomUUID(), second.id, localTimeForTest(), '00:00', '00:01'],
    );
    const { tick } = await import('../apps/worker/tick.js');
    await tick();
    const firstCount = received;
    a.ok(firstCount >= 2);
    await tick();
    a.equal(received, firstCount);
    const id = randomUUID();
    await sql.query(
      "INSERT INTO notification_outbox(branch_id,id,source_key,recipients,subject,body,status,lease_until) VALUES($1,$2,$3,$4,$5,$6,'sending',now()-interval '1 minute')",
      [
        branch,
        id,
        'uncertain-test',
        ['recipient@shifttrack.invalid'],
        'Entrega incierta',
        'Prueba local',
      ],
    );
    const { dispatchMail } = await import('../apps/worker/mail.js');
    await dispatchMail();
    a.equal(received, firstCount);
    a.equal(
      (await sql.query('SELECT status FROM notification_outbox WHERE id=$1', [id])).rows[0].status,
      'needs_review',
    );
    a.equal(
      (
        await call(`/notifications/${id}/retry`, {
          branch_id: branch,
          reason: 'Reintento explícito de prueba',
        })
      ).status,
      200,
    );
    await dispatchMail();
    a.equal(received, firstCount + 1);
  } finally {
    await sql.query('UPDATE alert_settings SET email_enabled=false WHERE branch_id=$1', [branch]);
    for (const [key, value] of Object.entries({
      SMTP_HOST: old.host,
      SMTP_PORT: old.port,
      SMTP_FROM: old.from,
      SMTP_USER: old.user,
      SMTP_PASSWORD: old.password,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => smtpServer.close(resolve));
  }
});
test('empleado desactivado conserva registros y sus comandos van a revisión', async () => {
  const c = command('shortage.create', { id: randomUUID(), product: 'Cuenta desactivada' });
  await sql.query('UPDATE users SET active=false,auth_version=auth_version+1 WHERE id=$1', [
    employee.id,
  ]);
  await a.rejects(() => apply(c), { code: 'REQUIRES_ADMIN_REVIEW' });
  a.equal(
    (await sql.query('SELECT count(*) FROM tickets WHERE actor_user_id=$1', [employee.id])).rows[0]
      .count,
    '1',
  );
});
