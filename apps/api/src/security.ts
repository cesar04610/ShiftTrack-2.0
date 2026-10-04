import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  randomUUID,
  randomBytes,
} from 'node:crypto';
import argon2 from 'argon2';
import { pool } from './db.js';
import {
  assert,
  canonical,
  offlineTypes,
  type User,
  type Command,
} from '../../../packages/domain/index.js';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function sessionToken(header?: string) {
  assert(
    header && /^Bearer [A-Za-z0-9_-]{43}$/.test(header),
    'UNAUTHENTICATED',
    'Inicia sesión.',
    401,
  );
  return header!.slice(7);
}
export async function issueSession(user: User) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const current = (await db.query('SELECT * FROM users WHERE id=$1 FOR SHARE', [user.id]))
      .rows[0];
    assert(
      current?.active && current.auth_version === user.auth_version,
      'UNAUTHENTICATED',
      'Cuenta o sesión desactivada.',
      401,
    );
    const accessToken = randomBytes(32).toString('base64url');
    const row = (
      await db.query(
        "INSERT INTO auth_sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,$3,now()+interval '8 hours') RETURNING expires_at",
        [digest(accessToken), current.id, current.auth_version],
      )
    ).rows[0];
    await db.query('DELETE FROM auth_sessions WHERE user_id=$1 AND expires_at<=now()', [
      current.id,
    ]);
    await db.query('COMMIT');
    return {
      access_token: accessToken,
      expires_at: row.expires_at,
      user: current,
      server_time: new Date().toISOString(),
    };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
export async function revokeSession(header?: string) {
  await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [digest(sessionToken(header))]);
}
export async function identity(header?: string): Promise<User> {
  const user = (
    await pool.query(
      'SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND s.auth_version=u.auth_version',
      [digest(sessionToken(header))],
    )
  ).rows[0];
  assert(user, 'UNAUTHENTICATED', 'Sesión vencida o desactivada. Inicia sesión.', 401);
  return user;
}
export async function checkPassword(username: string, password: string) {
  const row = (
    await pool.query(
      'SELECT u.*,p.hash FROM users u JOIN password_credentials p ON p.user_id=u.id WHERE username=$1',
      [username.trim().toLowerCase()],
    )
  ).rows[0];
  // A dummy hash keeps the costly password check present for unknown names too.
  const hash = row?.hash ?? (await dummyHash);
  const valid = await argon2.verify(hash, password);
  assert(valid && row?.active, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.', 401);
  const { hash: _, ...user } = row;
  return user as User;
}
const dummyHash = argon2.hash(randomBytes(32));
export function verifySignature(body: unknown, signature: string, jwk: object) {
  try {
    return verify(
      'sha256',
      Buffer.from(canonical(body)),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}
export async function issueGrant(user: User, deviceId: string, publicKey: object) {
  const device = (
    await pool.query(
      'SELECT d.*,b.assignment_epoch,b.device_id AS assigned_device FROM devices d JOIN branches b ON b.id=d.branch_id WHERE d.id=$1',
      [deviceId],
    )
  ).rows[0];
  assert(device?.active, 'DEVICE_NOT_ASSIGNED', 'Este equipo no está registrado.', 403);
  assert(
    user.role === 'employee' && user.branch_id === device.branch_id,
    'FORBIDDEN',
    'Solo empleados de esta sucursal preparan acceso operativo.',
    403,
  );
  const id = randomUUID(),
    issued = new Date(),
    expires = new Date(issued.getTime() + 8 * 3600_000);
  const body = {
    grant_id: id,
    user_id: user.id,
    branch_id: device.branch_id,
    device_id: device.id,
    assignment_epoch: device.assignment_epoch,
    auth_version: user.auth_version,
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    allowed_commands: offlineTypes.filter(
      (t) => !t.startsWith('supplier.') || device.assigned_device === device.id,
    ),
    public_key: publicKey,
  };
  const keys = (await pool.query('SELECT * FROM server_keys WHERE id=1')).rows[0];
  const signature = sign('sha256', Buffer.from(canonical(body)), {
    key: createPrivateKey({ key: keys.private_jwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  await pool.query('INSERT INTO grants VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    id,
    user.id,
    device.id,
    device.branch_id,
    user.auth_version,
    body,
    signature,
    issued,
    expires,
  ]);
  return { body, signature, server_public_key: keys.public_jwk };
}
export async function deviceIdentity(header?: string) {
  assert(header?.startsWith('Device '), 'UNAUTHENTICATED', 'Transporte de equipo requerido.', 401);
  const row = (
    await pool.query(
      'SELECT d.* FROM device_sessions s JOIN devices d ON d.id=s.device_id WHERE s.token_hash=$1 AND s.expires_at>now() AND d.active',
      [digest(header!.slice(7))],
    )
  ).rows[0];
  assert(row, 'UNAUTHENTICATED', 'Transporte vencido.', 401);
  return row;
}
export async function validateCommand(command: Command, deviceId: string) {
  const { signature, ...body } = command;
  const grant = (
    await pool.query(
      'SELECT g.*,u.active,u.auth_version AS current_auth_version FROM grants g JOIN users u ON u.id=g.user_id WHERE g.id=$1',
      [command.grant_id],
    )
  ).rows[0];
  assert(
    grant &&
      grant.device_id === deviceId &&
      body.device_id === deviceId &&
      grant.user_id === body.actor_user_id &&
      grant.branch_id === body.branch_id,
    'FORBIDDEN',
    'Concesión ajena o desconocida.',
    403,
  );
  assert(
    signature && verifySignature(body, signature, grant.body.public_key),
    'FORBIDDEN',
    'Firma de captura inválida.',
    403,
  );
  assert(
    grant.body.allowed_commands.includes(command.type),
    'FORBIDDEN',
    'Operación no autorizada.',
    403,
  );
  const occurred = Date.parse(command.occurred_at);
  assert(
    Number.isFinite(occurred) &&
      occurred >= +grant.issued_at &&
      occurred < +grant.expires_at &&
      occurred <= Date.now() + 60_000,
    'REQUIRES_ADMIN_REVIEW',
    'La hora de captura requiere revisión.',
  );
  assert(
    grant.active && grant.auth_version === grant.current_auth_version,
    'REQUIRES_ADMIN_REVIEW',
    'La cuenta cambió; conserva el pendiente para revisión.',
  );
  return grant;
}
