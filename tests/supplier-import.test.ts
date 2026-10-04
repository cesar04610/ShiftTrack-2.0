import { test, before, after } from 'node:test';
import { strict as a } from 'node:assert';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import ExcelJS from 'exceljs';
if (
  !process.env.MIGRATION_DATABASE_URL ||
  process.env.NODE_ENV === 'production' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(process.env.MIGRATION_DATABASE_URL).hostname,
  )
)
  throw Error('Las pruebas requieren PostgreSQL local.');
process.env.NODE_ENV = 'test';
const { app } = await import('../apps/api/src/server.js');
const { pool } = await import('../apps/api/src/db.js');
const { issueSession } = await import('../apps/api/src/security.js');
const { parseSuppliers } = await import('../apps/api/src/supplier-import.js');
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const branch = randomUUID(),
  other = randomUUID();
let server: ReturnType<typeof app.listen>, base: string, token: string, employeeToken: string;
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function workbook(
  rows: any[][],
  headers = ['Empresa', 'Representante', 'Teléfono', 'Tipo de producto'],
) {
  const b = new ExcelJS.Workbook(),
    s = b.addWorksheet('Proveedores');
  s.addRow(headers);
  rows.forEach((row) => s.addRow(row));
  return Buffer.from(await b.xlsx.writeBuffer());
}
async function call(
  buffer: Buffer,
  mode = 'preview',
  authorization = token,
  target = branch,
  operation = randomUUID(),
  hash?: string,
) {
  const query = new URLSearchParams({ branch_id: target, mode, operation_id: operation });
  if (hash) query.set('preview_hash', hash);
  const response = await fetch(`${base}/api/v1/suppliers/import?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': mime, Authorization: `Bearer ${authorization}` },
    body: new Uint8Array(buffer),
  });
  return { status: response.status, body: await response.json() };
}
before(async () => {
  await db.connect();
  await db.query('INSERT INTO branches(id,name) VALUES($1,$2),($3,$4)', [
    branch,
    'Importación prueba',
    other,
    'Otra sucursal',
  ]);
  for (const role of ['admin', 'employee']) {
    const u = (
      await db.query(
        'INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(), `${role}-${branch.slice(0, 8)}`, role, role, branch],
      )
    ).rows[0];
    const issued = await issueSession(u);
    if (role === 'admin') token = issued.access_token;
    else employeeToken = issued.access_token;
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await db.query('INSERT INTO suppliers(branch_id,id,company,representative) VALUES($1,$2,$3,$4)', [
    branch,
    randomUUID(),
    'Café Central',
    'Conservar representante',
  ]);
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  for (const table of ['processed_operations', 'audit_events', 'suppliers'])
    await db.query(`DELETE FROM ${table} WHERE branch_id=$1`, [branch]);
  await db.query(
    'DELETE FROM auth_sessions WHERE user_id IN(SELECT id FROM users WHERE branch_id=$1)',
    [branch],
  );
  await db.query('DELETE FROM users WHERE branch_id=$1', [branch]);
  await db.query('DELETE FROM branches WHERE id=ANY($1::uuid[])', [[branch, other]]);
  await db.end();
});
test('preview and concurrent confirmations omit duplicates and preserve existing supplier data', async () => {
  const file = await workbook([
    ['Nuevo proveedor', 'Ana', '001234', 'Bebidas'],
    ['  CAFE   CENTRAL  ', 'No cambiar', '', ''],
    ['NUEVO PROVEEDOR', '', '', ''],
  ]);
  const reviewed = await call(file);
  a.equal(reviewed.status, 200);
  a.deepEqual(reviewed.body.summary, { total: 3, new: 1, duplicate: 2, invalid: 0 });
  a.equal(reviewed.body.rows[0].phone, '001234');
  a.equal(
    (await db.query('SELECT count(*)::int n FROM suppliers WHERE branch_id=$1', [branch])).rows[0]
      .n,
    1,
  );
  const operation = randomUUID();
  const saved = await Promise.all([
    call(file, 'confirm', token, branch, operation, reviewed.body.preview_hash),
    call(file, 'confirm', token, branch, operation, reviewed.body.preview_hash),
  ]);
  for (const r of saved) {
    a.equal(r.status, 200);
    a.equal(r.body.imported, 1);
    a.equal(r.body.skipped, 2);
  }
  a.equal(
    (await db.query('SELECT count(*)::int n FROM suppliers WHERE branch_id=$1', [branch])).rows[0]
      .n,
    2,
  );
  a.equal(
    (
      await db.query('SELECT representative FROM suppliers WHERE company=$1 AND branch_id=$2', [
        'Café Central',
        branch,
      ])
    ).rows[0].representative,
    'Conservar representante',
  );
  a.equal(
    (await db.query('SELECT count(*)::int n FROM treasury_entries WHERE branch_id=$1', [branch]))
      .rows[0].n,
    0,
  );
});
test('invalid rows and formulas prevent the entire import without partially saving valid rows', async () => {
  const file = await workbook([
    ['Proveedor válido para corregir', '', '', ''],
    ['Proveedor con fórmula', { formula: '1+1', result: 2 }, '', ''],
    ['', '', '123', ''],
  ]);
  const reviewed = await call(file);
  a.equal(reviewed.status, 200);
  a.equal(reviewed.body.summary.invalid, 2);
  const saved = await call(
    file,
    'confirm',
    token,
    branch,
    randomUUID(),
    reviewed.body.preview_hash,
  );
  a.equal(saved.status, 400);
  a.equal(saved.body.code, 'INVALID_ROWS');
  a.equal(
    (
      await db.query('SELECT count(*)::int n FROM suppliers WHERE company=$1', [
        'Proveedor válido para corregir',
      ])
    ).rows[0].n,
    0,
  );
});
test('imports require admin access in the chosen branch and a matching file preview', async () => {
  const file = await workbook([['Proveedor permisos', '', '', '']]);
  a.equal((await call(file, 'preview', employeeToken)).status, 403);
  a.equal((await call(file, 'preview', token, other)).status, 403);
  a.equal((await call(file, 'preview', '')).status, 401);
  a.equal((await call(file, 'confirm')).status, 400);
  const changed = await workbook([['Proveedor archivo distinto', '', '', '']]);
  const preview = await call(file);
  a.equal(
    (await call(changed, 'confirm', token, branch, randomUUID(), preview.body.preview_hash)).status,
    400,
  );
});
test('the template uses the four requested columns and legacy supplier headers are supported', async () => {
  const response = await fetch(`${base}/api/v1/suppliers/import/template?branch_id=${branch}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  a.equal(response.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await response.arrayBuffer()) as any);
  a.deepEqual((book.worksheets[0].getRow(1).values as any[]).slice(1), [
    'Empresa',
    'Representante',
    'Teléfono',
    'Tipo de producto',
  ]);
  a.equal(book.worksheets[0].getColumn(3).numFmt, '@');
  const source = await workbook(
    [['Empresa antigua', 'Luis', '0099', 'Alimentos']],
    ['company_name', 'rep_name', 'rep_phone', 'product_type'],
  );
  const parsed = await parseSuppliers(source);
  a.equal(parsed.rows[0].company, 'Empresa antigua');
  a.equal(parsed.rows[0].phone, '0099');
});
test('malformed or excessive workbooks fail with a readable validation message', async () => {
  a.equal((await call(Buffer.from('not an Excel file'))).status, 400);
  const missing = await workbook([['Dato']], ['Otra columna']);
  a.equal((await call(missing)).body.code, 'INVALID_HEADERS');
  const empty = await workbook([]);
  a.equal((await call(empty)).body.code, 'EMPTY_EXCEL');
  const oversized = await workbook(Array.from({ length: 2001 }, (_, i) => [`Empresa ${i}`]));
  a.equal((await call(oversized)).body.code, 'EXCEL_TOO_LARGE');
  const bomb = await workbook([['Dato']]);
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(21 * 1024 * 1024, central + 24);
  a.equal((await call(bomb)).body.code, 'EXCEL_TOO_LARGE');
});
