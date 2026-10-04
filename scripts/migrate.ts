import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await db.connect();
try {
  await db.query('SELECT pg_advisory_lock(70204610)');
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL)',
  );
  for (const name of (await readdir('packages/database/migrations')).sort()) {
    const sql = await readFile(`packages/database/migrations/${name}`, 'utf8'),
      hash = createHash('sha256').update(sql).digest('hex');
    const existing = (await db.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [name]))
      .rows[0];
    if (existing) {
      if (existing.sha256 !== hash) throw Error(`Migración modificada: ${name}`);
      continue;
    }
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations VALUES($1,$2)', [name, hash]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  }
  if (process.env.NODE_ENV !== 'production') {
    await db.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='shifttrack_app') THEN CREATE ROLE shifttrack_app LOGIN PASSWORD 'shifttrack_app_local_only' NOSUPERUSER NOBYPASSRLS; END IF; END $$",
    );
    await db.query('GRANT USAGE ON SCHEMA public TO shifttrack_app');
    await db.query('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO shifttrack_app');
    await db.query('GRANT DELETE ON device_challenges,device_sessions TO shifttrack_app');
  }
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await db.query('INSERT INTO server_keys VALUES(1,$1,$2) ON CONFLICT(id) DO NOTHING', [
    pair.privateKey.export({ format: 'jwk' }),
    pair.publicKey.export({ format: 'jwk' }),
  ]);
  console.log('Migraciones verificadas.');
} finally {
  await db.end();
}
