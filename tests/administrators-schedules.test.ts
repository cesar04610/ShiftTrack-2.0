import { test, before, after } from 'node:test';
import { strict as a } from 'node:assert';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { canonical, type Command } from '../packages/domain/index.js';
if (
  !process.env.MIGRATION_DATABASE_URL ||
  process.env.NODE_ENV === 'production' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(process.env.MIGRATION_DATABASE_URL).hostname,
  )
)
  throw Error('Las pruebas requieren una base local.');
process.env.NODE_ENV = 'test';
const { app } = await import('../apps/api/src/server.js');
const { pool } = await import('../apps/api/src/db.js');
const { issueSession } = await import('../apps/api/src/security.js');
const { processCommand } = await import('../apps/api/src/commands.js');
const sql = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const branch = randomUUID(),
  other = randomUUID(),
  device = randomUUID();
const people: Record<string, any> = {},
  tokens: Record<string, string> = {};
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  publicKey = pair.publicKey.export({ format: 'jwk' });
let server: ReturnType<typeof app.listen>, base: string;
async function call(path: string, body?: any, role = 'admin', method?: string) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[role]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
before(async () => {
  await sql.connect();
  await sql.query(
    'INSERT INTO branches(id,name,register_count,supplier_register,initialized,balance_cents) VALUES($1,$2,3,3,true,10000),($3,$4,3,3,true,0)',
    [branch, 'Personal pruebas', other, 'Otra pruebas'],
  );
  const hash = (
    await sql.query(
      "SELECT p.hash FROM password_credentials p JOIN users u ON u.id=p.user_id WHERE u.username='ana' AND u.active LIMIT 1",
    )
  ).rows[0].hash;
  for (const role of ['admin', 'employee', 'superadmin']) {
    people[role] = (
      await sql.query(
        'INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [
          randomUUID(),
          `${role}-${branch}`,
          `Persona ${role}`,
          role,
          role === 'superadmin' ? null : branch,
        ],
      )
    ).rows[0];
    await sql.query('INSERT INTO password_credentials VALUES($1,$2)', [people[role].id, hash]);
    tokens[role] = (await issueSession(people[role])).access_token;
  }
  await sql.query('INSERT INTO devices(id,branch_id,name,public_key) VALUES($1,$2,$3,$4)', [
    device,
    branch,
    'Equipo pruebas',
    publicKey,
  ]);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  for (const table of [
    'tickets',
    'cuts',
    'clock_records',
    'supplier_events',
    'supplier_shifts',
    'suppliers',
    'schedules',
    'treasury_entries',
    'processed_operations',
    'audit_events',
    'register_leases',
    'grants',
  ])
    await sql.query(`DELETE FROM ${table} WHERE branch_id=ANY($1::uuid[])`, [[branch, other]]);
  await sql.query('DELETE FROM devices WHERE id=$1', [device]);
  const ids = Object.values(people).map((p) => p.id);
  await sql.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [ids]);
  await sql.query('DELETE FROM password_credentials WHERE user_id=ANY($1::uuid[])', [ids]);
  await sql.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
  await sql.query('DELETE FROM branches WHERE id=ANY($1::uuid[])', [[branch, other]]);
  await sql.end();
});
test('pizarra asigna todos los roles, medios turnos exactos, movimiento sin duplicar y rechaza cruces o sucursales ajenas', async () => {
  for (const role of ['employee', 'admin', 'superadmin']) {
    const create = await call('/schedules/board', {
      branch_id: branch,
      user_id: people[role].id,
      business_date: '2026-11-02',
      shift: 'morning',
    });
    a.equal(create.status, 200);
    const again = await call('/schedules/board', {
      branch_id: branch,
      user_id: people[role].id,
      business_date: '2026-11-02',
      shift: 'morning',
    });
    a.equal(again.body.id, create.body.id);
    let record = (await sql.query('SELECT * FROM schedules WHERE id=$1', [create.body.id])).rows[0];
    a.equal(record.start_time, '07:30:00');
    a.equal(record.end_time, '15:00:00');
    a.equal(
      (
        await call('/schedules/board', {
          id: create.body.id,
          branch_id: branch,
          user_id: people[role].id,
          business_date: '2026-11-02',
          shift: 'morning',
          half: true,
        })
      ).status,
      200,
    );
    record = (await sql.query('SELECT * FROM schedules WHERE id=$1', [create.body.id])).rows[0];
    a.equal(record.start_time, '12:00:00');
    a.equal(
      (
        await call('/schedules/board', {
          id: create.body.id,
          branch_id: branch,
          user_id: people[role].id,
          business_date: '2026-11-03',
          shift: 'afternoon',
          half: true,
        })
      ).status,
      200,
    );
    record = (await sql.query('SELECT * FROM schedules WHERE id=$1', [create.body.id])).rows[0];
    a.equal(record.start_time, '18:30:00');
    a.equal(record.end_time, '21:30:00');
    a.equal(
      (
        await call('/schedules/board', {
          id: create.body.id,
          branch_id: branch,
          user_id: people[role].id,
          business_date: '2026-11-03',
          shift: 'afternoon',
          half: false,
        })
      ).status,
      200,
    );
    a.equal(
      (await sql.query('SELECT start_time FROM schedules WHERE id=$1', [create.body.id])).rows[0]
        .start_time,
      '15:00:00',
    );
    a.equal(
      (
        await call('/schedules', {
          branch_id: branch,
          user_id: people[role].id,
          business_date: '2026-11-03',
          start_time: '16:00',
          end_time: '17:00',
        })
      ).status,
      409,
    );
    a.equal(
      (await sql.query('SELECT count(*)::int n FROM schedules WHERE user_id=$1', [people[role].id]))
        .rows[0].n,
      1,
    );
  }
  a.equal(
    (
      await call(
        '/schedules/board',
        {
          branch_id: branch,
          user_id: people.employee.id,
          business_date: '2026-11-04',
          shift: 'morning',
        },
        'employee',
      )
    ).status,
    403,
  );
  a.equal(
    (
      await call('/schedules/board', {
        branch_id: other,
        user_id: people.admin.id,
        business_date: '2026-11-04',
        shift: 'morning',
      })
    ).status,
    403,
  );
  a.equal(
    (
      await call(
        '/schedules/board',
        {
          branch_id: other,
          user_id: people.admin.id,
          business_date: '2026-11-04',
          shift: 'morning',
        },
        'superadmin',
      )
    ).status,
    404,
  );
  const snapshot = (await call(`/snapshot?branch_id=${branch}`)).body;
  a.ok(snapshot.users.some((u: any) => u.id === people.superadmin.id));
});
test('administradores pueden registrar entrada, corte y pagos; caja normal no autoriza proveedores y no admite ocupación duplicada', async () => {
  for (const role of ['admin', 'superadmin']) {
    a.equal(
      (await call('/registers/select', { branch_id: branch, register_number: null }, role)).status,
      200,
    );
    a.equal(
      (
        await call(
          '/registers/select',
          { branch_id: branch, register_number: 1, device_id: device, public_key: publicKey },
          role,
        )
      ).status,
      200,
    );
    a.equal(
      (await call('/registers/select', { branch_id: branch, register_number: 1 }, 'employee'))
        .status,
      409,
    );
    let issued = (
      await call(
        '/devices/user-grants',
        {
          branch_id: branch,
          device_id: device,
          public_key: publicKey,
          password: 'ShiftTrack-demo-2026!',
        },
        role,
      )
    ).body;
    a.ok(issued.body.allowed_commands.includes('cut.create'));
    a.ok(!issued.body.allowed_commands.includes('supplier.ticket.create'));
    a.equal((await call('/clock/in', { branch_id: branch }, role)).status, 200);
    async function apply(type: Command['type'], payload: Record<string, string>) {
      const state = (await sql.query('SELECT * FROM branches WHERE id=$1', [branch])).rows[0];
      if (type === 'supplier.shift.open') payload.previous_close_id = state.last_closed_shift || '';
      const c: Command = {
        operation_id: randomUUID(),
        schema_version: 1,
        type,
        branch_id: branch,
        device_id: device,
        actor_user_id: people[role].id,
        grant_id: issued.body.grant_id,
        assignment_epoch: state.assignment_epoch,
        device_seq: type.startsWith('supplier.') ? Number(state.device_seq) + 1 : 0,
        expected_version: String(state.version),
        occurred_at: new Date().toISOString(),
        depends_on: [],
        payload,
      };
      c.signature = sign('sha256', Buffer.from(canonical(c)), {
        key: pair.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64');
      return processCommand(c, device);
    }
    await a.rejects(
      () =>
        apply('cut.create', {
          id: randomUUID(),
          register_number: '3',
          sales_cents: '1000',
          card_cents: '0',
          declared_cents: '1000',
        }),
      { code: 'FORBIDDEN' },
    );
    await apply('cut.create', {
      id: randomUUID(),
      register_number: '1',
      sales_cents: '1000',
      card_cents: '0',
      declared_cents: '1000',
    });
    a.equal(
      (
        await call(
          '/registers/select',
          { branch_id: branch, register_number: 3, device_id: device, public_key: publicKey },
          role,
        )
      ).status,
      200,
    );
    issued = (
      await call(
        '/devices/user-grants',
        {
          branch_id: branch,
          device_id: device,
          public_key: publicKey,
          password: 'ShiftTrack-demo-2026!',
        },
        role,
      )
    ).body;
    a.equal(issued.body.branch_id, branch);
    a.ok(issued.body.allowed_commands.includes('supplier.ticket.create'));
    const supplier = randomUUID();
    await apply('supplier.create', { id: supplier, company: `Proveedor ${role}` });
    await apply('supplier.shift.open', { id: randomUUID() });
    await apply('supplier.ticket.create', {
      id: randomUUID(),
      supplier_id: supplier,
      amount_cents: '100',
      note: 'Pago de prueba',
    });
    const counted = (await sql.query('SELECT balance_cents FROM branches WHERE id=$1', [branch]))
      .rows[0].balance_cents;
    await apply('supplier.shift.close', { counted_cents: counted });
    a.equal((await call('/clock/out', { branch_id: branch }, role)).status, 200);
    a.equal(
      (await call('/registers/select', { branch_id: branch, register_number: null }, role)).status,
      200,
    );
  }
  const heartbeat = await call('/registers/heartbeat', { branch_id: branch, register_number: 3 });
  a.equal(heartbeat.status, 409);
  a.equal(heartbeat.body.code, 'REGISTER_RELEASED');
  a.equal(
    (
      await sql.query(
        'SELECT r.register_number FROM register_leases r JOIN users u ON u.id=r.user_id WHERE r.branch_id=$1',
        [branch],
      )
    ).rowCount,
    0,
  );
  a.equal(
    (await call('/registers/select', { branch_id: branch, register_number: null }, 'employee'))
      .status,
    403,
  );
  a.equal((await call('/registers/select', { branch_id: other, register_number: 1 })).status, 403);
  a.equal(
    (await sql.query('SELECT count(*)::int n FROM cuts WHERE branch_id=$1', [branch])).rows[0].n,
    2,
  );
  a.equal(
    (await sql.query('SELECT count(*)::int n FROM tickets WHERE branch_id=$1', [branch])).rows[0].n,
    2,
  );
});
test('Alertas corresponde al súper administrador y no permite cambios desde administrador', async () => {
  const body = {
    branch_id: branch,
    absence_tolerance_minutes: 15,
    cut_delay_minutes: 30,
    recipients: [],
    email_enabled: false,
  };
  a.equal((await call('/alerts/settings', body)).status, 403);
  const snapshot = (await call(`/snapshot?branch_id=${branch}`)).body;
  a.deepEqual(snapshot.alerts, []);
  a.equal(snapshot.alert_settings, null);
});
