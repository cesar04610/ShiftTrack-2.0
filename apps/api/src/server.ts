import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { z } from 'zod';
import { pool, context, transaction, admin, owner, verifyRuntimeRole } from './db.js';
import {
  identity,
  checkPassword,
  issueSession,
  revokeSession,
  issueGrant,
  deviceIdentity,
  verifySignature,
  digest,
} from './security.js';
import { processCommand, commandSchema } from './commands.js';
import { assert, AppError, cents, localTime, type User } from '../../../packages/domain/index.js';
import { modules } from './modules.js';
import { media } from './media.js';
import { prepareMediaStorage } from './storage.js';
export const app = express();
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
      },
    },
  }),
);
// El último proxy de Railway define la IP real; no confiar en cabeceras de cualquier origen.
if (process.env.RAILWAY_ENVIRONMENT_ID) app.set('trust proxy', 1);
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/v1/media', media);
app.use(express.json({ limit: '128kb' }));
app.get('/api/v1/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});
app.post(
  '/api/v1/auth/login',
  rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }),
  async (req, res) => {
    const body = z
      .object({ username: z.string().min(1).max(100), password: z.string().min(1).max(256) })
      .parse(req.body);
    const user = await checkPassword(body.username, body.password);
    res.json(await issueSession(user));
  },
);
app.get('/api/v1/auth/me', async (req, res) => res.json(await identity(req.headers.authorization)));
app.post('/api/v1/auth/logout', async (req, res) => {
  await revokeSession(req.headers.authorization);
  res.json({ ok: true });
});
app.post('/api/v1/auth/change-password', async (req, res) => {
  const user = await identity(req.headers.authorization),
    body = z
      .object({ old_password: z.string().min(1).max(256), password: z.string().min(12).max(256) })
      .parse(req.body);
  const hash = await argon2.hash(body.password);
  await transaction(user.branch_id || '', async (db) => {
    const current = (
      await db.query(
        'SELECT u.active,u.auth_version,p.hash FROM users u JOIN password_credentials p ON p.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,p',
        [user.id],
      )
    ).rows[0];
    assert(
      current?.active && current.auth_version === user.auth_version,
      'UNAUTHENTICATED',
      'Sesión desactivada.',
      401,
    );
    assert(
      await argon2.verify(current.hash, body.old_password),
      'INVALID_CREDENTIALS',
      'Usuario o contraseña incorrectos.',
      401,
    );
    await db.query('UPDATE password_credentials SET hash=$2 WHERE user_id=$1', [user.id, hash]);
    await db.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [user.id]);
    await db.query('DELETE FROM auth_sessions WHERE user_id=$1', [user.id]);
  });
  res.json({ ok: true });
});
app.get('/api/v1/branches', async (req, res) => {
  const u = await identity(req.headers.authorization);
  res.json(
    (
      await pool.query(
        'SELECT id,name,timezone,register_count,supplier_register,device_id,assignment_epoch,initialized,active FROM branches WHERE ($1::boolean OR id=$2) AND (active OR $3::boolean)',
        [
          u.role === 'superadmin',
          u.branch_id,
          u.role === 'superadmin' && req.query.include_archived === 'true',
        ],
      )
    ).rows,
  );
});
app.post('/api/v1/branches', async (req, res) => {
  const u = await identity(req.headers.authorization);
  owner(u);
  const b = z
    .object({
      name: z.string().trim().min(1).max(100),
      timezone: z.string().default('America/Mazatlan'),
      register_count: z.number().int().min(1).max(100),
      supplier_register: z.number().int().positive(),
    })
    .parse(req.body);
  assert(
    b.supplier_register <= b.register_count,
    'INVALID_REGISTER',
    'La caja de proveedores debe estar entre 1 y la cantidad de cajas.',
    400,
  );
  try {
    new Intl.DateTimeFormat('es', { timeZone: b.timezone });
  } catch {
    throw new AppError('INVALID_TIMEZONE', 'Zona horaria inválida.', 400);
  }
  res
    .status(201)
    .json(
      (
        await pool.query(
          'INSERT INTO branches(id,name,timezone,register_count,supplier_register) VALUES($1,$2,$3,$4,$5) RETURNING id,name',
          [randomUUID(), b.name, b.timezone, b.register_count, b.supplier_register],
        )
      ).rows[0],
    );
});
app.post(
  '/api/v1/branches/:id/deactivate',
  rateLimit({ windowMs: 15 * 60_000, limit: 10 }),
  async (req, res) => {
    const user = await identity(req.headers.authorization);
    owner(user);
    const id = z.uuid().parse(req.params.id);
    const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
    await transaction(id, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(70204611)');
      const credential = (
        await db.query(
          'SELECT u.active,u.auth_version,p.hash FROM users u JOIN password_credentials p ON p.user_id=u.id WHERE u.id=$1 FOR SHARE OF u,p',
          [user.id],
        )
      ).rows[0];
      assert(
        credential?.active && credential.auth_version === user.auth_version,
        'UNAUTHENTICATED',
        'Inicia sesión de nuevo.',
        401,
      );
      assert(
        await argon2.verify(credential.hash, password),
        'INVALID_CREDENTIALS',
        'Contraseña incorrecta. La sucursal no fue eliminada.',
        401,
      );
      const branch = (await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      assert(branch, 'NOT_FOUND', 'Sucursal no encontrada.', 404);
      assert(
        !branch.active_shift,
        'OPEN_SHIFT',
        'Cierra el turno de proveedores antes de eliminar la sucursal.',
        409,
      );
      if (branch.active) {
        await db.query('UPDATE branches SET active=false WHERE id=$1', [id]);
        await db.query('UPDATE users SET auth_version=auth_version+1 WHERE branch_id=$1', [id]);
        await db.query(
          'DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE branch_id=$1)',
          [id],
        );
        await db.query('UPDATE devices SET active=false WHERE branch_id=$1', [id]);
        await db.query(
          'DELETE FROM device_sessions WHERE device_id IN (SELECT id FROM devices WHERE branch_id=$1)',
          [id],
        );
        await audit(db, id, user, 'branch.deactivate', { name: branch.name });
      }
    });
    res.json({ ok: true });
  },
);
async function reserveRegister(req: express.Request, heartbeat = false) {
  const user = await identity(req.headers.authorization);
  assert(
    user.role === 'employee',
    'FORBIDDEN',
    'Solo empleados seleccionan una caja de trabajo.',
    403,
  );
  const { register_number } = z
    .object({ register_number: z.number().int().min(1).max(100) })
    .parse(req.body);
  const sessionHash = digest(req.headers.authorization!.slice(7));
  return transaction(user.branch_id!, async (db) => {
    const branch = (
      await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [user.branch_id])
    ).rows[0];
    assert(branch?.active, 'BRANCH_INACTIVE', 'Esta sucursal fue eliminada.', 403);
    assert(
      register_number <= branch.register_count,
      'INVALID_REGISTER',
      'Elige una de las cajas configuradas en tu sucursal.',
      400,
    );
    const validSession = (
      await db.query(
        'SELECT token_hash FROM auth_sessions WHERE token_hash=$1 AND expires_at>now() FOR SHARE',
        [sessionHash],
      )
    ).rowCount;
    assert(validSession, 'UNAUTHENTICATED', 'La sesión venció.', 401);
    await db.query('DELETE FROM register_leases WHERE expires_at<=now()');
    const held = (
      await db.query('SELECT * FROM register_leases WHERE register_number=$1', [register_number])
    ).rows[0];
    assert(
      !held || held.session_hash === sessionHash,
      'REGISTER_OCCUPIED',
      `La caja ${register_number} ya está ocupada. Selecciona otra caja.`,
      409,
    );
    if (heartbeat)
      assert(
        held?.session_hash === sessionHash,
        'REGISTER_LOST',
        'La reserva de caja venció. Selecciona tu caja nuevamente.',
        409,
      );
    await db.query('DELETE FROM register_leases WHERE session_hash=$1 AND register_number<>$2', [
      sessionHash,
      register_number,
    ]);
    const lease = (
      await db.query(
        "INSERT INTO register_leases(branch_id,register_number,session_hash,user_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 minutes') ON CONFLICT(branch_id,register_number) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING register_number,expires_at",
        [user.branch_id, register_number, sessionHash, user.id],
      )
    ).rows[0];
    return lease;
  });
}
app.post('/api/v1/registers/select', async (req, res) => res.json(await reserveRegister(req)));
app.post('/api/v1/registers/heartbeat', async (req, res) =>
  res.json(await reserveRegister(req, true)),
);
app.post('/api/v1/devices/register', async (req, res) => {
  const u = await identity(req.headers.authorization);
  owner(u);
  const body = z
    .object({
      id: z.uuid(),
      branch_id: z.uuid(),
      name: z.string().min(1).max(100),
      public_key: z
        .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() })
        .passthrough(),
      supplier_register: z.number().int().positive(),
      supplier_enabled: z.boolean().default(true),
    })
    .parse(req.body);
  const b = await context(u, body.branch_id);
  await transaction(b.id, async (db) => {
    const locked = (await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [b.id]))
      .rows[0];
    assert(
      !body.supplier_enabled || !locked.device_id,
      'DEVICE_ALREADY_ASSIGNED',
      'Ya hay un equipo designado. La sustitución requiere reconciliar sus pendientes.',
    );
    assert(
      !body.supplier_enabled || body.supplier_register === locked.supplier_register,
      'INVALID_REGISTER',
      'Usa la caja de proveedores configurada en la sucursal.',
      400,
    );
    await db.query('INSERT INTO devices(id,branch_id,name,public_key) VALUES($1,$2,$3,$4)', [
      body.id,
      b.id,
      body.name,
      body.public_key,
    ]);
    if (body.supplier_enabled)
      await db.query('UPDATE branches SET device_id=$2,supplier_register=$3 WHERE id=$1', [
        b.id,
        body.id,
        body.supplier_register,
      ]);
  });
  res.status(201).json({ id: body.id, branch_id: b.id });
});
app.post('/api/v1/devices/user-grants', async (req, res) => {
  const u = await identity(req.headers.authorization);
  const b = z
    .object({
      device_id: z.uuid(),
      password: z.string(),
      public_key: z
        .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() })
        .passthrough(),
    })
    .parse(req.body);
  await checkPassword(u.username, b.password);
  const selected = await transaction(
    u.branch_id!,
    async (db) =>
      (
        await db.query(
          'SELECT register_number FROM register_leases WHERE session_hash=$1 AND expires_at>now()',
          [digest(req.headers.authorization!.slice(7))],
        )
      ).rows[0]?.register_number ?? null,
  );
  res.json(await issueGrant(u, b.device_id, b.public_key, selected));
});
app.post(
  '/api/v1/devices/challenge',
  rateLimit({ windowMs: 60_000, limit: 60 }),
  async (req, res) => {
    const id = z.uuid().parse(req.body.device_id);
    assert(
      (await pool.query('SELECT id FROM devices WHERE id=$1 AND active', [id])).rowCount,
      'DEVICE_NOT_ASSIGNED',
      'Equipo no autorizado.',
      403,
    );
    const challenge = {
      id: randomUUID(),
      device_id: id,
      nonce: randomBytes(32).toString('base64'),
    };
    await pool.query("INSERT INTO device_challenges VALUES($1,$2,$3,now()+interval '1 minute')", [
      challenge.id,
      id,
      challenge.nonce,
    ]);
    res.json(challenge);
  },
);
app.post('/api/v1/devices/session', async (req, res) => {
  const b = z.object({ id: z.uuid(), signature: z.string().max(1024) }).parse(req.body);
  const challenge = (
    await pool.query('DELETE FROM device_challenges WHERE id=$1 AND expires_at>now() RETURNING *', [
      b.id,
    ])
  ).rows[0];
  assert(challenge, 'UNAUTHENTICATED', 'Desafío vencido.', 401);
  const d = (
    await pool.query('SELECT * FROM devices WHERE id=$1 AND active', [challenge.device_id])
  ).rows[0];
  assert(
    d &&
      verifySignature(
        { id: challenge.id, device_id: d.id, nonce: challenge.nonce },
        b.signature,
        d.public_key,
      ),
    'UNAUTHENTICATED',
    'Firma de equipo inválida.',
    401,
  );
  const token = randomBytes(32).toString('base64url');
  await pool.query("INSERT INTO device_sessions VALUES($1,$2,now()+interval '5 minutes')", [
    digest(token),
    d.id,
  ]);
  res.json({ token });
});
app.post('/api/v1/sync/push', async (req, res) => {
  const device = await deviceIdentity(req.headers.authorization);
  const commands = z.array(commandSchema).max(20).parse(req.body.commands),
    results = [];
  for (const c of commands) {
    try {
      results.push(await processCommand(c, device.id));
    } catch (e) {
      const err = e as AppError;
      results.push({
        operation_id: c.operation_id,
        status: 'needs_review',
        code:
          err.code ||
          ((err as any).code === '23505' ? 'DUPLICATE_BUSINESS_RECORD' : 'INVALID_COMMAND'),
        message: err.message,
      });
    }
  }
  res.json({ results });
});
app.get('/api/v1/snapshot', async (req, res) => {
  const user = await identity(req.headers.authorization),
    b = await context(user, req.query.branch_id as string, true);
  res.json(
    await transaction(b.id, async (db) => {
      const select = async (table: string, own = false) =>
        (
          await db.query(
            `SELECT * FROM ${table} ${own && user.role === 'employee' ? 'WHERE user_id=$1' : ''} ORDER BY id`,
            own && user.role === 'employee' ? [user.id] : [],
          )
        ).rows;
      const active = b.active_shift
        ? (await db.query('SELECT * FROM supplier_shifts WHERE id=$1', [b.active_shift])).rows[0]
        : null;
      const result: any = {
        branch: { ...b, active_shift: active },
        suppliers: await select('suppliers'),
        tasks: await select('tasks', true),
        schedules: await select('schedules', true),
        clock: await select('clock_records', true),
        cuts: await select('cuts', true),
        shortages: await select('shortages'),
      };
      if (user.role !== 'employee' || b.device_id === req.query.device_id) {
        result.tickets = await select('tickets');
        result.shifts = await select('supplier_shifts');
      }
      if (user.role !== 'employee') {
        result.users = (
          await db.query(
            'SELECT id,username,name,role,branch_id,active FROM users WHERE branch_id=$1 OR role=$2',
            [b.id, user.role === 'superadmin' ? 'superadmin' : 'none'],
          )
        ).rows;
        result.treasury = await select('treasury_entries');
        result.audit = await select('audit_events');
        result.catalog = await select('task_catalog');
        result.assignments = await select('task_assignments');
        result.corrections = await select('supplier_corrections');
        result.alerts = await select('alerts');
        result.categories = await select('expense_categories');
        result.alert_settings = (await db.query('SELECT * FROM alert_settings')).rows[0];
        result.notifications = await select('notification_outbox');
      }
      return result;
    }),
  );
});
app.post('/api/v1/users', async (req, res) => {
  const u = await identity(req.headers.authorization);
  admin(u);
  const p = z
    .object({
      username: z.string().regex(/^[a-z0-9._-]{3,50}$/),
      name: z.string().min(1).max(100),
      role: z.enum(['superadmin', 'admin', 'employee']),
      branch_id: z.uuid(),
      password: z.string().min(12).max(256),
    })
    .parse(req.body);
  const b = await context(u, p.branch_id);
  assert(
    u.role === 'superadmin' || p.role === 'employee',
    'FORBIDDEN',
    'Solo el dueño crea cuentas administrativas.',
    403,
  );
  const id = randomUUID(),
    hash = await argon2.hash(p.password);
  await transaction(b.id, async (db) => {
    await db.query('INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,$3,$4,$5)', [
      id,
      p.username,
      p.name,
      p.role,
      p.role === 'superadmin' ? null : b.id,
    ]);
    await db.query('INSERT INTO password_credentials VALUES($1,$2)', [id, hash]);
    await audit(db, b.id, u, 'user.create', { id, role: p.role });
  });
  res.status(201).json({ id });
});
app.post('/api/v1/users/:id/deactivate', async (req, res) => {
  const u = await identity(req.headers.authorization);
  admin(u);
  const id = z.uuid().parse(req.params.id);
  const target = (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  assert(target, 'NOT_FOUND', 'Cuenta no encontrada.', 404);
  assert(
    u.role === 'superadmin' || (target.role === 'employee' && target.branch_id === u.branch_id),
    'FORBIDDEN',
    'No puedes desactivar esta cuenta.',
    403,
  );
  // Serialize owner changes so concurrent deactivations cannot remove the last owner.
  const branch = await context(u, req.body.branch_id);
  await transaction(branch.id, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(70204611)');
    if (target.role === 'superadmin')
      assert(
        Number(
          (await db.query("SELECT count(*) FROM users WHERE role='superadmin' AND active")).rows[0]
            .count,
        ) > 1,
        'LAST_OWNER',
        'Debe quedar un dueño activo.',
      );
    await db.query('UPDATE users SET active=false,auth_version=auth_version+1 WHERE id=$1', [id]);
    await db.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
    await audit(db, branch.id, u, 'user.deactivate', { id });
  });
  res.json({ ok: true });
});
app.post('/api/v1/clock/:action', async (req, res) => {
  const u = await identity(req.headers.authorization);
  assert(u.role === 'employee', 'FORBIDDEN', 'El registro de entrada es del empleado.', 403);
  const b = await context(u, req.body.branch_id),
    date = localTime(new Date(), b.timezone).date;
  await transaction(b.id, async (db) => {
    if (req.params.action === 'in')
      await db.query(
        'INSERT INTO clock_records(branch_id,id,user_id,business_date,clock_in) VALUES($1,$2,$3,$4,now())',
        [b.id, randomUUID(), u.id, date],
      );
    else {
      assert(req.params.action === 'out', 'NOT_FOUND', 'Acción inválida.', 404);
      assert(
        (
          await db.query(
            'UPDATE clock_records SET clock_out=now() WHERE user_id=$1 AND business_date=$2 AND clock_out IS NULL RETURNING id',
            [u.id, date],
          )
        ).rowCount,
        'NO_CLOCK',
        'No hay entrada abierta hoy.',
      );
    }
  });
  res.json({ ok: true });
});
app.post('/api/v1/schedules', async (req, res) => {
  const u = await identity(req.headers.authorization);
  admin(u);
  const b = await context(u, req.body.branch_id);
  const p = z
    .object({
      user_id: z.uuid(),
      business_date: z.iso.date(),
      start_time: z.string().regex(/^\d{2}:\d{2}$/),
      end_time: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .parse(req.body);
  await transaction(b.id, async (db) => {
    await employee(db, b.id, p.user_id);
    await db.query('INSERT INTO schedules VALUES($1,$2,$3,$4,$5,$6)', [
      b.id,
      randomUUID(),
      p.user_id,
      p.business_date,
      p.start_time,
      p.end_time,
    ]);
  });
  res.status(201).json({ ok: true });
});
app.post('/api/v1/tasks', async (req, res) => {
  const u = await identity(req.headers.authorization);
  admin(u);
  const b = await context(u, req.body.branch_id);
  const p = z
    .object({
      user_id: z.uuid(),
      title: z.string().min(1).max(200),
      due_date: z.iso.date(),
      priority: z.enum(['normal', 'alta']).default('normal'),
    })
    .parse(req.body);
  await transaction(b.id, async (db) => {
    await employee(db, b.id, p.user_id);
    await db.query(
      'INSERT INTO tasks(branch_id,id,user_id,title,due_date,priority) VALUES($1,$2,$3,$4,$5,$6)',
      [b.id, randomUUID(), p.user_id, p.title, p.due_date, p.priority],
    );
  });
  res.status(201).json({ ok: true });
});
app.post('/api/v1/treasury/opening', async (req, res) => {
  const u = await identity(req.headers.authorization);
  admin(u);
  const b = await context(u, req.body.branch_id);
  const p = z
    .object({ cash_cents: z.string(), bank_cents: z.string(), supplier_cents: z.string() })
    .parse(req.body);
  const cash = cents(p.cash_cents),
    bank = cents(p.bank_cents),
    supplier = cents(p.supplier_cents);
  assert(
    cash >= 0n && bank >= 0n && supplier >= 0n && supplier <= cash,
    'INVALID_AMOUNT',
    'Proveedores debe ser parte del efectivo total.',
    400,
  );
  await transaction(b.id, async (db) => {
    const row = (await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [b.id])).rows[0];
    assert(!row.initialized, 'ALREADY_INITIALIZED', 'La sucursal ya tiene apertura.');
    await db.query('UPDATE branches SET initialized=true,balance_cents=$2 WHERE id=$1', [
      b.id,
      supplier.toString(),
    ]);
    const id = randomUUID();
    await db.query(
      'INSERT INTO treasury_entries(branch_id,id,source_id,kind,cash_cents,bank_cents,note,actor_user_id) VALUES($1,$2,$2,$3,$4,$5,$6,$7)',
      [
        b.id,
        id,
        'opening',
        cash.toString(),
        bank.toString(),
        'Apertura; proveedores incluido en efectivo total',
        u.id,
      ],
    );
    await audit(db, b.id, u, 'treasury.opening', p);
  });
  res.json({ ok: true });
});
app.post('/api/v1/treasury/movements', async (req, res) => {
  const u = await identity(req.headers.authorization);
  admin(u);
  const b = await context(u, req.body.branch_id);
  const p = z
    .object({
      kind: z.enum(['expense', 'bank_withdrawal', 'cash_adjustment', 'bank_adjustment']),
      operation_id: z.uuid(),
      amount_cents: z.string(),
      note: z.string().trim().min(1).max(1000),
    })
    .parse(req.body);
  const amount = cents(p.amount_cents);
  if (p.kind === 'expense' || p.kind === 'bank_withdrawal')
    assert(amount > 0n, 'INVALID_AMOUNT', 'El importe debe ser positivo.', 400);
  const cash = p.kind === 'expense' ? -amount : p.kind === 'bank_adjustment' ? 0n : amount;
  const bank = p.kind === 'bank_withdrawal' ? -amount : p.kind === 'bank_adjustment' ? amount : 0n;
  await transaction(b.id, async (db) => {
    await db.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [b.id]);
    const hash = digest(JSON.stringify({ actor: u.id, ...p }));
    const existing = (
      await db.query('SELECT * FROM processed_operations WHERE id=$1', [p.operation_id])
    ).rows[0];
    if (existing) {
      assert(
        existing.request_hash === hash,
        'VERSION_CONFLICT',
        'Identificador reutilizado con otro movimiento.',
      );
      return;
    }
    assert(b.initialized, 'OPENING_REQUIRED', 'Registra primero los saldos de arranque.');
    const id = p.operation_id;
    await db.query(
      'INSERT INTO treasury_entries(branch_id,id,source_id,kind,cash_cents,bank_cents,note,actor_user_id) VALUES($1,$2,$2,$3,$4,$5,$6,$7)',
      [b.id, id, p.kind, cash.toString(), bank.toString(), p.note, u.id],
    );
    await audit(db, b.id, u, 'treasury.movement', { id, ...p });
    await db.query('INSERT INTO processed_operations VALUES($1,$2,$3,$4)', [
      b.id,
      id,
      hash,
      { operation_id: id, status: 'confirmed' },
    ]);
  });
  res.status(201).json({ ok: true });
});
async function audit(db: any, branch: string, user: User, action: string, payload: unknown) {
  await db.query('INSERT INTO audit_events VALUES($1,$2,$3,$4,$5,now())', [
    branch,
    randomUUID(),
    user.id,
    action,
    payload,
  ]);
}
async function employee(db: any, branch: string, id: string) {
  assert(
    (
      await db.query(
        "SELECT id FROM users WHERE id=$1 AND branch_id=$2 AND active AND role='employee'",
        [id, branch],
      )
    ).rowCount,
    'NOT_FOUND',
    'Empleado no disponible en la sucursal.',
    404,
  );
}
app.use('/api/v1', modules);
if (process.env.WEB_DIST_DIR) {
  const webDir = resolve(process.env.WEB_DIST_DIR);
  app.use('/api', (_req, res) =>
    res.status(404).json({ code: 'NOT_FOUND', message: 'Ruta API no encontrada.' }),
  );
  app.use(
    express.static(webDir, {
      setHeaders(res, path) {
        if (path.endsWith('/sw.js') || path.endsWith('/index.html'))
          res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(webDir, 'index.html')));
}
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof z.ZodError ? 400 : err.code === '23505' ? 409 : err.status || 500;
  res.status(status).json({
    code:
      err instanceof z.ZodError
        ? 'VALIDATION_ERROR'
        : err.code === '23505'
          ? 'DUPLICATE_BUSINESS_RECORD'
          : err.code || 'INTERNAL_ERROR',
    message:
      status === 500
        ? 'No se pudo completar la operación.'
        : err instanceof z.ZodError
          ? 'Revisa los campos de la captura.'
          : err.code === '23505'
            ? 'Este registro ya existe.'
            : err.message,
  });
  if (status === 500) console.error({ code: err.code, message: err.message });
});
if (process.env.NODE_ENV !== 'test') {
  await prepareMediaStorage();
  await verifyRuntimeRole();
  app.listen(Number(process.env.PORT || 8080), '0.0.0.0', () =>
    console.log('API ShiftTrack disponible.'),
  );
}
