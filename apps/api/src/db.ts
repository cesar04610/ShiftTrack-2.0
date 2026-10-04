import pg from 'pg';
import { assert, type User } from '../../../packages/domain/index.js';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export async function verifyRuntimeRole() {
  const role = (
    await pool.query(
      `SELECT r.rolsuper,r.rolbypassrls,EXISTS(SELECT 1 FROM pg_tables t WHERE t.schemaname='public' AND t.tableowner=current_user) owns_tables FROM pg_roles r WHERE r.rolname=current_user`,
    )
  ).rows[0];
  assert(
    role && !role.rolsuper && !role.rolbypassrls && !role.owns_tables,
    'UNSAFE_DATABASE_ROLE',
    'DATABASE_URL debe utilizar el rol de aplicación sin propiedad de tablas ni bypass RLS.',
    500,
  );
}
export async function transaction<T>(
  branchId: string,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.branch_id',$1,true)", [branchId]);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
export async function context(user: User, requested?: string) {
  const branch = user.role === 'superadmin' ? requested : user.branch_id;
  assert(branch, 'BRANCH_REQUIRED', 'Selecciona una sucursal.', 400);
  assert(
    !requested || user.role === 'superadmin' || requested === user.branch_id,
    'FORBIDDEN',
    'Sin acceso a esta sucursal.',
    403,
  );
  const row = (await pool.query('SELECT * FROM branches WHERE id=$1', [branch])).rows[0];
  assert(row, 'NOT_FOUND', 'Sucursal no encontrada.', 404);
  return row;
}
export function admin(user: User) {
  assert(user.role !== 'employee', 'FORBIDDEN', 'Requiere administrador.', 403);
}
export function owner(user: User) {
  assert(user.role === 'superadmin', 'FORBIDDEN', 'Requiere superadministrador.', 403);
}
