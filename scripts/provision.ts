import pg from 'pg';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Proceso administrativo temporal. Nunca montar esta función como ruta HTTP pública.
let stage = 'configuration';
let db: pg.Client | undefined;
try {
  if (process.env.NODE_ENV !== 'production') throw Error('Production setup only');
  const migrationUrl = new URL(process.env.MIGRATION_DATABASE_URL || '');
  const runtimeUrl = new URL(process.env.RUNTIME_DATABASE_URL || '');
  if (
    runtimeUrl.username !== 'shifttrack_app' ||
    runtimeUrl.hostname !== migrationUrl.hostname ||
    runtimeUrl.port !== migrationUrl.port ||
    runtimeUrl.pathname !== migrationUrl.pathname
  )
    throw Error('The runtime and migration identities must use the same database');
  const appPassword = decodeURIComponent(runtimeUrl.password);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(appPassword)) throw Error('Invalid application credential');

  stage = 'migrations';
  await import('./migrate.js');
  db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(70204611)');
  stage = 'runtime-role';
  const owns = await db.query(
    "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tableowner='shifttrack_app' LIMIT 1",
  );
  if (owns.rowCount) throw Error('The application role must not own tables');
  if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname='shifttrack_app'")).rowCount)
    await db.query(
      'CREATE ROLE shifttrack_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
    );
  // DDL no admite parámetros directamente; PostgreSQL quotea el literal, sin registrarlo.
  const alter = (
    await db.query(
      "SELECT format('ALTER ROLE shifttrack_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text) AS statement",
      [appPassword],
    )
  ).rows[0].statement;
  await db.query(alter);
  await db.query(await readFile('infra/runtime-role.sql', 'utf8'));

  stage = 'owner';
  const existing = await db.query("SELECT id FROM users WHERE role='superadmin' LIMIT 1");
  if (!existing.rowCount) {
    const password = process.env.BOOTSTRAP_OWNER_PASSWORD || '';
    const username = (process.env.BOOTSTRAP_OWNER_USERNAME || 'cesar').trim().toLowerCase();
    const name = (process.env.BOOTSTRAP_OWNER_NAME || 'César Galaviz').trim();
    if (
      !/^[a-z0-9._-]{3,50}$/.test(username) ||
      !name ||
      password.length < 12 ||
      password.length > 256
    )
      throw Error('Owner configuration is required');
    const id = randomUUID();
    await db.query("INSERT INTO users(id,username,name,role) VALUES($1,$2,$3,'superadmin')", [
      id,
      username,
      name,
    ]);
    await db.query('INSERT INTO password_credentials VALUES($1,$2)', [
      id,
      await argon2.hash(password),
    ]);
  }
  await db.query('COMMIT');
  console.log('PROVISION_COMPLETE: migraciones, rol restringido y dueño preparados.');
} catch (error: any) {
  if (db) await db.query('ROLLBACK').catch(() => {});
  // No imprimir errores del driver, URLs, hashes, consultas ni credenciales.
  console.error({
    status: 'PROVISION_FAILED',
    stage,
    code: /^[A-Z0-9_]{2,40}$/.test(error?.code || '') ? error.code : 'SETUP_ERROR',
  });
  process.exitCode = 1;
} finally {
  await db?.end();
  delete process.env.BOOTSTRAP_OWNER_PASSWORD;
}
