import pg from 'pg';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
if (
  !['development', 'test'].includes(process.env.NODE_ENV || '') ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(
    new URL(process.env.MIGRATION_DATABASE_URL || '').hostname,
  )
)
  throw Error('Los datos de ejemplo solo se permiten en desarrollo con PostgreSQL local.');
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN');
  let branch = (
    await db.query("SELECT id FROM branches WHERE name='Sucursal Centro' ORDER BY id LIMIT 1")
  ).rows[0]?.id;
  if (!branch) {
    branch = randomUUID();
    await db.query('INSERT INTO branches(id,name) VALUES($1,$2)', [branch, 'Sucursal Centro']);
  }
  const password = 'ShiftTrack-demo-2026!';
  for (const [username, name, role] of [
    ['cesar', 'César Galaviz', 'superadmin'],
    ['admin', 'Administración Centro', 'admin'],
    ['ana', 'Ana López', 'employee'],
    ['luis', 'Luis Ramírez', 'employee'],
  ]) {
    const id = randomUUID();
    const row = (
      await db.query(
        'INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
        [id, username, name, role, role === 'superadmin' ? null : branch],
      )
    ).rows[0];
    if (row)
      await db.query('INSERT INTO password_credentials VALUES($1,$2)', [
        id,
        await argon2.hash(password),
      ]);
  }
  await db.query('COMMIT');
  console.log('Datos de desarrollo disponibles. Consulta README para las cuentas de ejemplo.');
} catch (e) {
  await db.query('ROLLBACK');
  throw e;
} finally {
  await db.end();
}
