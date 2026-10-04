import pg from 'pg';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
// Run from an authorized terminal; no initial password in source or command line.
let masked = false;
const output = new Writable({
  write(chunk, _encoding, done) {
    if (!masked) process.stdout.write(chunk);
    done();
  },
});
const prompt = createInterface({ input: process.stdin, output, terminal: true });
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  const username = (await prompt.question('Usuario del primer dueño: ')).trim().toLowerCase();
  const name = (await prompt.question('Nombre: ')).trim();
  process.stdout.write('Contraseña (mínimo 12 caracteres; entrada oculta): ');
  masked = true;
  const password = await prompt.question('');
  masked = false;
  process.stdout.write('\n');
  if (!/^[a-z0-9._-]{3,50}$/.test(username) || !name || password.length < 12)
    throw Error('Datos inválidos.');
  await db.connect();
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(70204611)');
  if ((await db.query("SELECT id FROM users WHERE role='superadmin'")).rowCount)
    throw Error('Ya existe un dueño; usa la administración de usuarios.');
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
  await db.query('COMMIT');
  console.log('Primer dueño creado.');
} finally {
  prompt.close();
  await db.end();
}
