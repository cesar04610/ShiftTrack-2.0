import { schedules } from './schedules.js';
import { writeAudit } from './audit-detail.js';
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
  passwordAccounts,
  issueSession,
  revokeSession,
  issueGrant,
  deviceIdentity,
  verifySignature,
  digest,
} from './security.js';
import { processCommand, commandSchema } from './commands.js';
import {
  assert,
  AppError,
  cents,
  localTime,
  shiftBusinessDate,
  type User,
} from '../../../packages/domain/index.js';
import { reports } from './reports.js';
import { modules } from './modules.js';
import { supplierImport } from './supplier-import.js';
import { sales, salesSnapshot } from './sales.js';
import { media, purgeExpiredMedia } from './media.js';
import { closeAbandonedClocks } from './attendance.js';
import { alertsReady } from './alerts.js';
import { assignSetupTasks, setupReady, taskSetup } from './task-setup.js';
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
// The browser test suite signs in more than 30 times per run against one local API; only an
// explicit development or test environment gets the wider limit, production keeps the strict one.
const loginLimit = ['development', 'test'].includes(process.env.NODE_ENV || '') ? 300 : 30;
app.post(
  '/api/v1/auth/login',
  rateLimit({
    windowMs: 15 * 60_000,
    limit: loginLimit,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  async (req, res) => {
    const body = z
      .object({
        username: z.string().min(1).max(100),
        password: z.string().min(1).max(256),
        branch_id: z.union([z.uuid(), z.literal('owner')]).optional(),
      })
      .parse(req.body);
    const matched = await passwordAccounts(
      body.username,
      body.password,
      body.branch_id === 'owner' ? undefined : body.branch_id,
    ).catch(async (error) => {
      await recordFailedLogin(body.username, body.branch_id).catch(() => undefined);
      throw error;
    });
    const users =
      body.branch_id === 'owner' ? matched.filter((u) => u.role === 'superadmin') : matched;
    assert(users.length, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.', 401);
    if (users.length > 1) {
      const ids = users.map((u) => u.branch_id).filter(Boolean);
      const branches = (
        await pool.query('SELECT id,name FROM branches WHERE id=ANY($1::uuid[]) ORDER BY name', [
          ids,
        ])
      ).rows;
      res.json({
        branch_required: true,
        branches: [
          ...branches,
          ...(users.some((u) => u.role === 'superadmin')
            ? [{ id: 'owner', name: 'Superadministración' }]
            : []),
        ],
      });
      return;
    }
    res.json(await issueSession(users[0]));
  },
);
app.get('/api/v1/auth/me', async (req, res) => res.json(await identity(req.headers.authorization)));
app.post('/api/v1/auth/logout', async (req, res) => {
  await revokeSession(req.headers.authorization);
  res.json({ ok: true });
});
app.post('/api/v1/auth/logout-on-close', async (req, res) => {
  const { token } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(req.body);
  await revokeSession(`Bearer ${token}`);
  res.json({ ok: true });
});
app.post('/api/v1/auth/change-password', async (req, res) => {
  const user = await identity(req.headers.authorization),
    body = z
      .object({ old_password: z.string().min(1).max(256), password: z.string().min(4).max(256) })
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
    if (user.branch_id) await audit(db, user.branch_id, user, 'auth.password_change', {});
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
      timezone: z.string().default('America/Chihuahua'),
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
// A wrong password is logged under the branch of the account it tried, when that is unambiguous.
async function recordFailedLogin(username: string, branchId?: string) {
  const accounts = (
    await pool.query(
      `SELECT id,branch_id FROM users WHERE username=$1 AND deleted_at IS NULL AND branch_id IS NOT NULL
       AND ($2::uuid IS NULL OR branch_id=$2)`,
      [
        username
          .trim()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase(),
        branchId && branchId !== 'owner' ? branchId : null,
      ],
    )
  ).rows;
  if (accounts.length !== 1) return;
  await transaction(accounts[0].branch_id, (db) =>
    writeAudit(db, accounts[0].branch_id, accounts[0].id, 'auth.login_failed', {}),
  );
}
async function reserveRegister(req: express.Request, heartbeat = false) {
  const user = await identity(req.headers.authorization);
  const selectedBranch = await context(user, req.body.branch_id, req.body.register_number === null);
  if (req.body.register_number === null) {
    admin(user);
    await transaction(selectedBranch.id, async (db) => {
      await db.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [selectedBranch.id]);
      const left = await db.query(
        'DELETE FROM register_leases WHERE session_hash=$1 RETURNING register_number',
        [digest(req.headers.authorization!.slice(7))],
      );
      if (left.rowCount)
        await audit(db, selectedBranch.id, user, 'register.leave', {
          register_number: left.rows[0].register_number,
        });
    });
    return { register_number: null, device_id: null };
  }
  const { register_number } = z
    .object({ register_number: z.number().int().min(1).max(100) })
    .parse(req.body);
  const sessionHash = digest(req.headers.authorization!.slice(7));
  return transaction(selectedBranch.id, async (db) => {
    const branch = (
      await db.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE', [selectedBranch.id])
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
        'SELECT token_hash FROM auth_sessions WHERE token_hash=$1 AND (expires_at IS NULL OR expires_at>now()) FOR SHARE',
        [sessionHash],
      )
    ).rowCount;
    assert(validSession, 'UNAUTHENTICATED', 'La sesión venció.', 401);
    await db.query(
      'DELETE FROM register_leases WHERE expires_at<=now() OR session_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at<=now())',
    );
    const held = (
      await db.query('SELECT * FROM register_leases WHERE register_number=$1', [register_number])
    ).rows[0];
    assert(
      !heartbeat || held?.session_hash === sessionHash,
      'REGISTER_RELEASED',
      'Tu caja fue liberada. Selecciona una caja para continuar.',
      409,
    );
    // Reclaim only this user's prior session on the same enrolled browser/device.
    // A late close notification can only revoke its old token, never the replacement.
    let recovered = false;
    if (
      !heartbeat &&
      held &&
      held.session_hash !== sessionHash &&
      held.user_id === user.id &&
      req.body.device_id &&
      req.body.public_key &&
      (!held.device_id || held.device_id === req.body.device_id)
    ) {
      const previousDevice = (
        await db.query('SELECT * FROM devices WHERE id=$1', [z.uuid().parse(req.body.device_id)])
      ).rows[0];
      if (
        previousDevice?.active &&
        previousDevice.branch_id === selectedBranch.id &&
        previousDevice.public_key.x === req.body.public_key.x &&
        previousDevice.public_key.y === req.body.public_key.y
      ) {
        await db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [held.session_hash]);
        recovered = true;
      }
    }
    assert(
      !held || held.session_hash === sessionHash || recovered,
      'REGISTER_OCCUPIED',
      `La caja ${register_number} ya está ocupada. Selecciona otra caja.`,
      409,
    );

    await db.query('DELETE FROM register_leases WHERE session_hash=$1 AND register_number<>$2', [
      sessionHash,
      register_number,
    ]);
    let deviceId: string | null = held?.device_id ?? null;
    if (!heartbeat && req.body.device_id && req.body.public_key) {
      const enrollment = z
        .object({
          device_id: z.uuid(),
          public_key: z
            .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() })
            .passthrough(),
        })
        .parse(req.body);
      const existing = (await db.query('SELECT * FROM devices WHERE id=$1', [enrollment.device_id]))
        .rows[0];
      if (existing?.active && existing.branch_id === selectedBranch.id) {
        assert(
          existing.public_key.x === enrollment.public_key.x &&
            existing.public_key.y === enrollment.public_key.y,
          'FORBIDDEN',
          'La clave de este equipo no coincide.',
          403,
        );
        deviceId = existing.id;
      } else {
        deviceId = existing ? randomUUID() : enrollment.device_id;
        await db.query('INSERT INTO devices(id,branch_id,name,public_key) VALUES($1,$2,$3,$4)', [
          deviceId,
          selectedBranch.id,
          `Caja ${register_number} · ${user.username}`,
          enrollment.public_key,
        ]);
      }
    }
    const lease = (
      await db.query(
        'INSERT INTO register_leases(branch_id,register_number,session_hash,user_id,expires_at,device_id) VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT(branch_id,register_number) DO UPDATE SET expires_at=NULL,device_id=EXCLUDED.device_id RETURNING register_number,expires_at,device_id',
        [selectedBranch.id, register_number, sessionHash, user.id, deviceId],
      )
    ).rows[0];
    if (!heartbeat && (!held || held.session_hash !== sessionHash))
      await audit(db, selectedBranch.id, user, 'register.select', { register_number });
    // Whoever takes a register receives the tasks of that register and shift.
    if (!heartbeat) await assignSetupTasks(db, branch, user.id, register_number);
    return lease;
  });
}
app.post('/api/v1/registers/select', async (req, res) => res.json(await reserveRegister(req)));
app.post('/api/v1/registers/heartbeat', async (req, res) =>
  res.json(await reserveRegister(req, true)),
);
app.get('/api/v1/registers', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const branch = await context(user, req.query.branch_id as string);
  res.json(
    await transaction(
      branch.id,
      async (db) =>
        (
          await db.query(
            'SELECT r.register_number,u.name,u.username FROM register_leases r JOIN users u ON u.id=r.user_id ORDER BY r.register_number',
          )
        ).rows,
    ),
  );
});
app.post(
  '/api/v1/registers/:number/release',
  rateLimit({ windowMs: 15 * 60_000, limit: 10 }),
  async (req, res) => {
    const user = await identity(req.headers.authorization);
    admin(user);
    const branch = await context(user, req.body.branch_id);
    const password = z.string().min(1).max(256).parse(req.body.password);
    await checkPassword(user.username, password, undefined, user.id);
    const number = z.coerce.number().int().positive().parse(req.params.number);
    await transaction(branch.id, async (db) => {
      await db.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [branch.id]);
      const lease = (
        await db.query('SELECT * FROM register_leases WHERE register_number=$1', [number])
      ).rows[0];
      if (lease) {
        await db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [lease.session_hash]);
        await audit(db, branch.id, user, 'register.release', {
          register_number: number,
          user_id: lease.user_id,
        });
      }
    });
    res.json({ ok: true });
  },
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
  await checkPassword(u.username, b.password, undefined, u.id);
  const grantBranch = await context(u, req.body.branch_id);
  const grantDevice = (
    await pool.query('SELECT branch_id FROM devices WHERE id=$1 AND active', [b.device_id])
  ).rows[0];
  assert(grantDevice, 'DEVICE_NOT_ASSIGNED', 'Este equipo no está registrado.', 403);
  assert(
    grantDevice.branch_id === grantBranch.id,
    'DEVICE_BRANCH_MISMATCH',
    'Este equipo está registrado en otra sucursal. Usa un equipo de tu sucursal para preparar el acceso offline.',
    403,
  );
  const selected = await transaction(
    grantBranch.id,
    async (db) =>
      (
        await db.query(
          'SELECT register_number FROM register_leases WHERE session_hash=$1 AND (expires_at IS NULL OR expires_at>now())',
          [digest(req.headers.authorization!.slice(7))],
        )
      ).rows[0]?.register_number ?? null,
  );
  if (u.role !== 'employee')
    assert(
      selected != null,
      'REGISTER_REQUIRED',
      'Selecciona una caja para preparar el acceso operativo.',
      400,
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
// Days of history sent with each refresh of the screen and kept on the device for offline work.
export const SNAPSHOT_DAYS = 15;
app.get('/api/v1/snapshot', async (req, res) => {
  const user = await identity(req.headers.authorization),
    b = await context(user, req.query.branch_id as string, true);
  res.json(
    await transaction(b.id, async (db) => {
      // Only recent history travels with every refresh; older records stay in Reportes.
      const sinceAt = new Date(Date.now() - SNAPSHOT_DAYS * 86_400_000).toISOString();
      const sinceDate = new Date(
        Date.parse(`${shiftBusinessDate(new Date(), b.timezone)}T00:00:00Z`) -
          SNAPSHOT_DAYS * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      const select = async (table: string, own = false, where = '', values: unknown[] = []) => {
        const conditions = where ? [`(${where})`] : [];
        const params = [...values];
        if (own && user.role === 'employee') {
          params.push(user.id);
          conditions.push(`user_id=$${params.length}`);
        }
        return (
          await db.query(
            `SELECT * FROM ${table}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id`,
            params,
          )
        ).rows;
      };
      const active = b.active_shift
        ? (await db.query('SELECT * FROM supplier_shifts WHERE id=$1', [b.active_shift])).rows[0]
        : null;
      const result: any = {
        history_since: sinceDate,
        branch: { ...b, active_shift: active },
        suppliers: await select('suppliers'),
        tasks: await select('tasks', true, 'due_date>=$1::date', [sinceDate]),
        schedules: await select('schedules', true, 'business_date>=$1::date', [sinceDate]),
        clock: await select('clock_records', true, 'clock_out IS NULL OR clock_in>=$1', [sinceAt]),
        cuts: await select('cuts', true, 'business_date>=$1::date', [sinceDate]),
        shortages: await select('shortages', false, 'NOT resolved OR occurred_at>=$1', [sinceAt]),
        ...(await salesSnapshot(db, user.id)),
      };
      const selected =
        user.role === 'employee'
          ? (
              await db.query('SELECT register_number FROM register_leases WHERE session_hash=$1', [
                digest(req.headers.authorization!.slice(7)),
              ])
            ).rows[0]?.register_number
          : null;
      if (
        user.role !== 'employee' ||
        selected === b.supplier_register ||
        (selected == null && b.device_id === req.query.device_id)
      ) {
        // The open shift and the last close always travel, whatever their age, for the relay.
        const current = [b.active_shift, b.last_closed_shift].filter(Boolean);
        result.tickets = await select(
          'tickets',
          false,
          'occurred_at>=$1 OR shift_id=ANY($2::uuid[])',
          [sinceAt, current],
        );
        result.shifts = await select(
          'supplier_shifts',
          false,
          'opened_at>=$1 OR closed_at IS NULL OR id=ANY($2::uuid[])',
          [sinceAt, current],
        );
      }
      if (user.role !== 'employee') {
        result.users = (
          await db.query(
            'SELECT id,username,name,role,branch_id,active,deleted_at FROM users WHERE branch_id=$1 OR role=$2',
            [b.id, 'superadmin'],
          )
        ).rows;
        result.treasury = await select('treasury_entries', false, 'occurred_at>=$1', [sinceAt]);
        // The general cash balance covers every movement, not only the recent ones sent above.
        result.treasury_totals = (
          await db.query(
            'SELECT coalesce(sum(cash_cents),0)::text AS cash_cents,coalesce(sum(bank_cents),0)::text AS bank_cents FROM treasury_entries',
          )
        ).rows[0];
        result.audit = await select('audit_events', false, 'received_at>=$1', [sinceAt]);
        // The task lists of every register and shift, for Gestionar tareas.
        result.task_setup = (await setupReady(db))
          ? (
              await db.query(
                'SELECT id,shift,half,register_number,title,weekdays FROM task_setup_items WHERE active ORDER BY created_at,id',
              )
            ).rows
          : [];
        result.corrections = await select('supplier_corrections', false, 'occurred_at>=$1', [
          sinceAt,
        ]);
        // Recent register movements (balance additions) for the supplier-register day detail.
        result.supplier_events = (
          await db.query(
            "SELECT * FROM supplier_events WHERE type='supplier.balance.add' AND occurred_at > now() - interval '3 days' ORDER BY occurred_at",
          )
        ).rows;
        result.categories = await select('expense_categories');
        // Who is working right now and at which register, for the dashboard.
        result.occupied_registers = (
          await db.query('SELECT register_number,user_id FROM register_leases')
        ).rows;
        result.alerts =
          user.role === 'superadmin' && (await alertsReady(db))
            ? (await db.query('SELECT * FROM alert_log ORDER BY occurred_at DESC LIMIT 300')).rows
            : [];
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
      password: z.string().min(4).max(256),
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
    assert(
      !(
        await db.query(
          'SELECT id FROM users WHERE username=$1 AND branch_id IS NOT DISTINCT FROM $2::uuid AND deleted_at IS NULL',
          [p.username, p.role === 'superadmin' ? null : b.id],
        )
      ).rowCount,
      'USER_EXISTS',
      'Ya existe un usuario con ese nombre en esta sucursal.',
      409,
    );
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
    // Same rule as deleting: a deactivated person could never close their open supplier shift.
    assert(
      !(
        await db.query(
          'SELECT id FROM supplier_shifts WHERE actor_user_id=$1 AND closed_at IS NULL',
          [id],
        )
      ).rowCount,
      'OPEN_SHIFT',
      'Cierra el turno de proveedores de esta persona antes de desactivarla.',
      409,
    );
    await db.query('UPDATE users SET active=false,auth_version=auth_version+1 WHERE id=$1', [id]);
    await db.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
    await audit(db, branch.id, u, 'user.deactivate', { id });
  });
  res.json({ ok: true });
});
app.post('/api/v1/users/:id/delete', async (req, res) => {
  const actor = await identity(req.headers.authorization);
  admin(actor);
  const id = z.uuid().parse(req.params.id),
    branch = await context(actor, req.body.branch_id);
  const password = z.string().max(256).optional().parse(req.body.password);
  await transaction(branch.id, async (db) => {
    await db.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [branch.id]);
    // Lock every owner too, so two owners cannot delete each other at the same time.
    await db.query(
      "SELECT id FROM users WHERE role='superadmin' AND deleted_at IS NULL ORDER BY id FOR UPDATE",
    );
    const target = (await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
    assert(target, 'NOT_FOUND', 'Cuenta no encontrada.', 404);
    assert(target.id !== actor.id, 'FORBIDDEN', 'No puedes eliminar tu propia cuenta.', 403);
    if (target.role === 'employee')
      assert(
        target.branch_id === branch.id,
        'FORBIDDEN',
        'Solo puedes eliminar empleados de esta sucursal.',
        403,
      );
    else {
      // Administrators and owners: only an owner, and only after typing their own password.
      assert(
        actor.role === 'superadmin',
        'FORBIDDEN',
        'Solo un súper administrador puede eliminar administradores.',
        403,
      );
      assert(
        target.role === 'superadmin' || target.branch_id === branch.id,
        'FORBIDDEN',
        'Solo puedes eliminar administradores de esta sucursal.',
        403,
      );
      let confirmed = false;
      try {
        confirmed =
          !!password && !!(await checkPassword(actor.username, password, undefined, actor.id));
      } catch {
        confirmed = false;
      }
      assert(confirmed, 'WRONG_PASSWORD', 'La contraseña no es correcta.', 403);
      if (target.role === 'superadmin' && !target.deleted_at)
        assert(
          (
            await db.query(
              "SELECT 1 FROM users WHERE role='superadmin' AND active AND deleted_at IS NULL AND id<>$1",
              [id],
            )
          ).rowCount,
          'LAST_OWNER',
          'Debe quedar al menos un súper administrador activo.',
          409,
        );
    }
    assert(
      !(
        await db.query(
          'SELECT id FROM supplier_shifts WHERE actor_user_id=$1 AND closed_at IS NULL',
          [id],
        )
      ).rowCount,
      'OPEN_SHIFT',
      'Cierra el turno de proveedores de esta persona antes de eliminarla.',
      409,
    );
    if (!target.deleted_at) {
      await db.query(
        'UPDATE users SET active=false,deleted_at=now(),auth_version=auth_version+1 WHERE id=$1',
        [id],
      );
      await db.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
      await audit(db, branch.id, actor, 'user.delete', {
        id,
        username: target.username,
        name: target.name,
        role: target.role,
      });
    }
  });
  res.json({ ok: true });
});
app.post('/api/v1/clock/:action', async (req, res) => {
  const u = await identity(req.headers.authorization);
  const b = await context(u, req.body.branch_id),
    date = shiftBusinessDate(new Date(), b.timezone);
  await transaction(b.id, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
    if (req.params.action === 'in') {
      assert(
        !(
          await db.query('SELECT id FROM clock_records WHERE user_id=$1 AND clock_out IS NULL', [
            u.id,
          ])
        ).rowCount,
        'OPEN_CLOCK',
        'Ya tienes una entrada abierta. Registra la salida antes de iniciar otro turno.',
        409,
      );
      await db.query(
        'INSERT INTO clock_records(branch_id,id,user_id,business_date,clock_in) VALUES($1,$2,$3,$4,now())',
        [b.id, randomUUID(), u.id, date],
      );
    } else {
      assert(req.params.action === 'out', 'NOT_FOUND', 'Acción inválida.', 404);
      assert(
        (
          await db.query(
            'UPDATE clock_records SET clock_out=now() WHERE user_id=$1 AND clock_out IS NULL RETURNING id',
            [u.id],
          )
        ).rowCount,
        'NO_CLOCK',
        'No hay una entrada abierta.',
      );
    }
  });
  res.json({ ok: true });
});
app.use('/api/v1/schedules', schedules);
app.use('/api/v1/tasks', taskSetup);
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
// Bank movements of any date range, with the running balance over the whole history. The screen
// only keeps recent history, so the "Movimientos bancarios" page asks for its range here.
app.get('/api/v1/treasury/bank', async (req, res) => {
  const u = await identity(req.headers.authorization);
  admin(u);
  const q = z
    .object({ branch_id: z.string().optional(), from: z.iso.date(), to: z.iso.date() })
    .parse(req.query);
  assert(
    q.from <= q.to,
    'INVALID_RANGE',
    'La fecha inicial no puede ser posterior a la final.',
    400,
  );
  assert(
    (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 400,
    'INVALID_RANGE',
    'El rango máximo es de 400 días.',
    400,
  );
  const b = await context(u, q.branch_id, true);
  res.json(
    await transaction(b.id, async (db) => {
      // Days are counted in the branch's time zone, as on the screen.
      const day = '(occurred_at AT TIME ZONE $1)::date';
      const totals = (
        await db.query(
          `SELECT coalesce(sum(bank_cents) FILTER (WHERE ${day}<$2::date),0)::text AS opening_cents,
                  coalesce(sum(bank_cents),0)::text AS current_cents
           FROM treasury_entries`,
          [b.timezone, q.from],
        )
      ).rows[0];
      const rows = (
        await db.query(
          `SELECT id,kind,note,occurred_at,bank_cents::text AS bank_cents FROM treasury_entries
           WHERE bank_cents<>0 AND ${day} BETWEEN $2::date AND $3::date ORDER BY occurred_at,id`,
          [b.timezone, q.from, q.to],
        )
      ).rows;
      let running = BigInt(totals.opening_cents);
      return {
        ...totals,
        entries: rows.map((r) => ({
          ...r,
          balance_cents: (running += BigInt(r.bank_cents)).toString(),
        })),
      };
    }),
  );
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
  await writeAudit(db, branch, user.id, action, payload as Record<string, unknown>);
}
async function employee(db: any, branch: string, id: string) {
  assert(
    (
      await db.query(
        "SELECT id FROM users WHERE id=$1 AND (branch_id=$2 OR role='superadmin') AND active",
        [id, branch],
      )
    ).rowCount,
    'NOT_FOUND',
    'Persona no disponible en la sucursal.',
    404,
  );
}
app.use('/api/v1/suppliers/import', supplierImport);
app.use('/api/v1', sales);
app.use('/api/v1', reports);
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
    console.log('API Mostrador disponible.'),
  );
  const purge = () =>
    purgeExpiredMedia()
      .then((n) => n && console.log({ status: 'MEDIA_PURGED', removed: n }))
      .catch(() => console.error({ status: 'MEDIA_PURGE_FAILED' }));
  void purge();
  setInterval(purge, 6 * 3600_000).unref();
  const closeClocks = () =>
    closeAbandonedClocks()
      .then((n) => n && console.log({ status: 'CLOCKS_CLOSED', closed: n }))
      .catch(() => console.error({ status: 'CLOCK_SWEEP_FAILED' }));
  void closeClocks();
  setInterval(closeClocks, 5 * 60_000).unref();
}
