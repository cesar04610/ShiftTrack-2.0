import express from 'express';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assert, cents, type Command } from '../../../packages/domain/index.js';
import { identity } from './security.js';
import { writeAudit } from './audit-detail.js';
import { admin, context, transaction } from './db.js';
import { readXls, type XlsCell } from './xls.js';

// Backup sales: the catalog exported from SICAR and the sales captured while SICAR is down.
const MAX_PRODUCTS = 20_000;
export const MAX_SALE_LINES = 150;

let ready = false;
// Deployments that have not applied the sales migration yet keep working without this module.
export async function salesReady(db: Pick<pg.PoolClient, 'query'>) {
  if (ready) return true;
  ready = !!(await db.query("SELECT to_regclass('public.sale_items') AS t")).rows[0].t;
  return ready;
}

type Product = {
  clave: string;
  clave_alterna: string;
  description: string;
  price_cents: string;
  bulk: boolean;
};
type Issue = { row: number; clave: string; description: string; message: string };
const header = (value: XlsCell) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(s\/n\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
type Column = 'clave' | 'clave_alterna' | 'description' | 'price' | 'bulk' | 'vat' | 'ieps';
const columns: Record<Column, string[]> = {
  clave: ['clave'],
  clave_alterna: ['clave alterna'],
  description: ['descripcion'],
  price: ['precio 1'],
  bulk: ['granel'],
  vat: ['impuesto'],
  ieps: ['imp ieps'],
};
const text = (value: XlsCell) =>
  typeof value === 'number'
    ? Number.isFinite(value)
      ? String(value)
      : ''
    : (value ?? '').replace(/\s+/g, ' ').trim();
const yes = (value: XlsCell) => /^(s|si|sí|true|1)$/i.test(text(value));
// SICAR writes prices as text with six decimals; millionths of a peso keep them exact.
function micro(value: XlsCell): bigint | null {
  const raw = typeof value === 'number' ? value.toFixed(6) : text(value);
  if (!/^\d{1,9}(\.\d{1,9})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

// PRECIO 1 comes without taxes: IEPS (8%) and then IVA (16%) are added when their column says S.
export function publicPrice(base: bigint, vat: boolean, ieps: boolean) {
  const exact = base * (vat ? 116n : 100n) * (ieps ? 108n : 100n),
    unit = 100_000_000n,
    rounded = (exact + unit / 2n) / unit;
  // Shelf prices end in .00 or .50; anything else usually means a tax flag is missing in SICAR.
  return { cents: rounded, uneven: rounded % 50n !== 0n };
}

export function parseCatalog(file: Buffer) {
  const rows = readXls(file);
  const found: Partial<Record<Column, number>> = {};
  (rows[0] || []).forEach((cell, index) => {
    const name = header(cell);
    for (const [key, names] of Object.entries(columns) as [Column, string[]][])
      if (names.includes(name) && found[key] === undefined) found[key] = index;
  });
  const missing = [
    ['clave', 'CLAVE'],
    ['description', 'DESCRIPCION'],
    ['price', 'PRECIO 1'],
    ['bulk', 'GRANEL (S/N)'],
  ].filter(([key]) => found[key as Column] === undefined);
  assert(
    !missing.length,
    'INVALID_HEADERS',
    `Al archivo le falta la columna ${missing.map((m) => m[1]).join(', ')} en la primera fila. Usa la exportación de artículos de SICAR sin modificarla.`,
    400,
  );
  const products: Product[] = [],
    invalid: Issue[] = [],
    uneven: Issue[] = [],
    seen = new Set<string>();
  let unpriced = 0;
  const cell = (row: XlsCell[], key: Column) =>
    found[key] === undefined ? undefined : row[found[key]!];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.every((value) => text(value) === '')) continue;
    const clave = text(cell(row, 'clave')),
      description = text(cell(row, 'description')),
      alternate = text(cell(row, 'clave_alterna')),
      base = micro(cell(row, 'price'));
    const reject = (message: string) =>
      invalid.push({ row: index + 1, clave, description, message });
    if (!clave) reject('No tiene clave.');
    else if (clave.length > 60 || alternate.length > 60) reject('La clave supera 60 caracteres.');
    else if (!description) reject('No tiene descripción.');
    else if (base === null) reject('El precio no es un número válido.');
    else if (seen.has(clave.toLowerCase())) reject('Clave repetida en el archivo.');
    else {
      const price = publicPrice(base, yes(cell(row, 'vat')), yes(cell(row, 'ieps')));
      if (price.cents > 100_000_000n) {
        reject('El precio es demasiado alto.');
        continue;
      }
      seen.add(clave.toLowerCase());
      if (price.cents === 0n) unpriced++;
      else if (price.uneven)
        uneven.push({
          row: index + 1,
          clave,
          description,
          message: `Se cobrará $${(Number(price.cents) / 100).toFixed(2)}`,
        });
      products.push({
        clave,
        clave_alterna: alternate.toLowerCase() === clave.toLowerCase() ? '' : alternate,
        description: description.slice(0, 200),
        price_cents: price.cents.toString(),
        bulk: yes(cell(row, 'bulk')),
      });
    }
  }
  assert(
    products.length,
    'EMPTY_EXCEL',
    'El archivo no contiene productos válidos debajo de los encabezados.',
    400,
  );
  assert(
    products.length <= MAX_PRODUCTS,
    'EXCEL_TOO_LARGE',
    `El catálogo admite hasta ${MAX_PRODUCTS.toLocaleString('es-MX')} productos.`,
    400,
  );
  return { products, invalid, uneven, unpriced };
}

export const sales = express.Router();
sales.post(
  '/products/import',
  express.raw({ type: 'application/vnd.ms-excel', limit: '8mb' }),
  async (req, res) => {
    const user = await identity(req.headers.authorization);
    admin(user);
    const branch = await context(user, req.query.branch_id as string);
    const input = z
      .object({
        mode: z.enum(['preview', 'confirm']),
        operation_id: z.uuid().optional(),
        preview_hash: z.string().length(64).optional(),
      })
      .parse(req.query);
    assert(Buffer.isBuffer(req.body), 'INVALID_EXCEL', 'Selecciona el archivo .xls de SICAR.', 400);
    const hash = createHash('sha256').update(req.body).digest('hex');
    const parsed = parseCatalog(req.body);
    const result = await transaction(branch.id, async (db) => {
      const locked = (
        await db.query('SELECT active FROM branches WHERE id=$1 FOR UPDATE', [branch.id])
      ).rows[0];
      assert(locked?.active, 'BRANCH_INACTIVE', 'Esta sucursal está desactivada.', 403);
      const existing = new Map<string, any>(
        (
          await db.query(
            'SELECT clave,clave_alterna,description,price_cents::text AS price_cents,bulk,active FROM products',
          )
        ).rows.map((r) => [r.clave, r]),
      );
      const insensitive = new Map([...existing.values()].map((r) => [r.clave.toLowerCase(), r]));
      let added = 0,
        changed = 0;
      for (const p of parsed.products) {
        const old = existing.get(p.clave) ?? insensitive.get(p.clave.toLowerCase());
        if (!old) added++;
        else if (
          !old.active ||
          old.clave !== p.clave ||
          old.clave_alterna !== p.clave_alterna ||
          old.description !== p.description ||
          old.price_cents !== p.price_cents ||
          old.bulk !== p.bulk
        )
          changed++;
      }
      const incoming = new Set(parsed.products.map((p) => p.clave.toLowerCase()));
      const removed = [...existing.values()].filter(
        (r) => r.active && !incoming.has(r.clave.toLowerCase()),
      ).length;
      const summary = {
        total: parsed.products.length,
        new: added,
        changed,
        unchanged: parsed.products.length - added - changed,
        removed,
        bulk: parsed.products.filter((p) => p.bulk).length,
        unpriced: parsed.unpriced,
        uneven: parsed.uneven.length,
        invalid: parsed.invalid.length,
      };
      if (input.mode === 'preview')
        return {
          summary,
          invalid: parsed.invalid.slice(0, 100),
          uneven: parsed.uneven.slice(0, 100),
          sample: parsed.products.slice(0, 8),
          preview_hash: hash,
        };
      assert(
        input.operation_id && input.preview_hash === hash,
        'PREVIEW_REQUIRED',
        'Revisa primero la vista previa de este archivo.',
        400,
      );
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            type: 'products.import',
            branch: branch.id,
            actor: user.id,
            file: hash,
          }),
        )
        .digest('hex');
      const done = (
        await db.query('SELECT * FROM processed_operations WHERE id=$1', [input.operation_id])
      ).rows[0];
      if (done) {
        assert(
          done.request_hash === requestHash,
          'VERSION_CONFLICT',
          'Esta importación corresponde a otro archivo.',
          409,
        );
        return done.result;
      }
      await db.query(
        `INSERT INTO products(branch_id,id,clave,clave_alterna,description,price_cents,bulk)
         SELECT $1,gen_random_uuid(),t.clave,t.clave_alterna,t.description,t.price_cents,t.bulk
         FROM unnest($2::text[],$3::text[],$4::text[],$5::bigint[],$6::boolean[])
           AS t(clave,clave_alterna,description,price_cents,bulk)
         ON CONFLICT (branch_id,lower(clave)) DO UPDATE SET clave=EXCLUDED.clave,
           clave_alterna=EXCLUDED.clave_alterna,description=EXCLUDED.description,
           price_cents=EXCLUDED.price_cents,bulk=EXCLUDED.bulk,active=true,updated_at=now()
         WHERE (products.clave,products.clave_alterna,products.description,products.price_cents,products.bulk,products.active)
           IS DISTINCT FROM (EXCLUDED.clave,EXCLUDED.clave_alterna,EXCLUDED.description,EXCLUDED.price_cents,EXCLUDED.bulk,true)`,
        [
          branch.id,
          parsed.products.map((p) => p.clave),
          parsed.products.map((p) => p.clave_alterna),
          parsed.products.map((p) => p.description),
          parsed.products.map((p) => p.price_cents),
          parsed.products.map((p) => p.bulk),
        ],
      );
      // The file is the whole catalog: what it no longer lists stops being sold, but is kept.
      await db.query(
        'UPDATE products SET active=false,updated_at=now() WHERE active AND NOT (clave=ANY($1::text[]))',
        [parsed.products.map((p) => p.clave)],
      );
      const count = (await db.query('SELECT count(*)::int AS n FROM products WHERE active')).rows[0]
        .n;
      await db.query(
        `INSERT INTO product_catalogs(branch_id,version,product_count,imported_at,imported_by)
         VALUES($1,1,$2,now(),$3)
         ON CONFLICT(branch_id) DO UPDATE SET version=product_catalogs.version+1,
           product_count=EXCLUDED.product_count,imported_at=now(),imported_by=EXCLUDED.imported_by`,
        [branch.id, count, user.id],
      );
      const saved = { ...summary, message: 'Catálogo guardado correctamente.' };
      await writeAudit(db, branch.id, user.id, 'products.import', {
        operation_id: input.operation_id,
        file_sha256: hash,
        ...summary,
      });
      await db.query('INSERT INTO processed_operations VALUES($1,$2,$3,$4)', [
        branch.id,
        input.operation_id,
        requestHash,
        saved,
      ]);
      return saved;
    });
    res.json(result);
  },
);
// The whole active catalog, kept on each device so sales also work without Internet.
sales.get('/products', async (req, res) => {
  const user = await identity(req.headers.authorization),
    branch = await context(user, req.query.branch_id as string, true);
  res.json(
    await transaction(branch.id, async (db) => {
      if (!(await salesReady(db))) return { version: 0, products: [] };
      const version = Number(
        (await db.query('SELECT version FROM product_catalogs')).rows[0]?.version ?? 0,
      );
      if (String(req.query.version ?? '') === String(version)) return { version, unchanged: true };
      return {
        version,
        products: (
          await db.query(
            'SELECT id,clave,clave_alterna,description,price_cents::int AS price,bulk FROM products WHERE active ORDER BY description,clave',
          )
        ).rows.map((r) => [r.id, r.clave, r.clave_alterna, r.description, r.price, r.bulk ? 1 : 0]),
      };
    }),
  );
});
// Sales of one work day (05:00 to 05:00, as cuts) with their lines, for administrators.
sales.get('/sales', async (req, res) => {
  const user = await identity(req.headers.authorization);
  admin(user);
  const q = z.object({ branch_id: z.string().optional(), date: z.iso.date() }).parse(req.query);
  const branch = await context(user, q.branch_id, true);
  res.json(
    await transaction(branch.id, async (db) => {
      if (!(await salesReady(db))) return { date: q.date, sales: [] };
      const rows = (
        await db.query(
          `SELECT s.id,s.user_id,u.name AS user_name,s.register_number,s.payment,
                  s.total_cents::text,s.received_cents::text,s.change_cents::text,s.occurred_at
           FROM sales s JOIN users u ON u.id=s.user_id
           WHERE ((s.occurred_at AT TIME ZONE $1) - interval '5 hours')::date=$2::date
           ORDER BY s.occurred_at,s.id`,
          [branch.timezone, q.date],
        )
      ).rows;
      const items = (
        await db.query(
          `SELECT sale_id,clave,description,quantity_milli::int AS quantity_milli,
                  unit_price_cents::text,total_cents::text
           FROM sale_items WHERE sale_id=ANY($1::uuid[]) ORDER BY sale_id,line`,
          [rows.map((r) => r.id)],
        )
      ).rows;
      const bySale = new Map<string, any[]>();
      for (const { sale_id, ...item } of items)
        bySale.set(sale_id, [...(bySale.get(sale_id) || []), item]);
      return { date: q.date, sales: rows.map((r) => ({ ...r, items: bySale.get(r.id) || [] })) };
    }),
  );
});

const itemsSchema = z
  .array(
    z.tuple([
      z.uuid(),
      z.number().int().positive().max(9_999_000),
      z.number().int().positive().max(100_000_000),
    ]),
  )
  .min(1)
  .max(MAX_SALE_LINES);
// One sale captured at a register. The device sends the price the cashier saw, so a sale made
// offline with yesterday's catalog is stored exactly as it was charged.
export async function recordSale(db: pg.PoolClient, branch: any, c: Command) {
  assert(await salesReady(db), 'SCHEMA_NOT_READY', 'Las ventas aún no están disponibles.');
  const p = c.payload,
    id = z.uuid().parse(p.id),
    payment = z.enum(['cash', 'card']).parse(p.payment);
  let raw: unknown;
  try {
    raw = JSON.parse(p.items);
  } catch {
    assert(false, 'INVALID_SALE', 'La venta no tiene productos válidos.', 400);
  }
  const items = itemsSchema.parse(raw);
  const known = new Map<string, any>(
    (
      await db.query('SELECT id,clave,description FROM products WHERE id=ANY($1::uuid[])', [
        items.map((i) => i[0]),
      ])
    ).rows.map((r) => [r.id, r]),
  );
  let total = 0n;
  const lines = items.map(([product, quantity, price], index) => {
    const found = known.get(product);
    assert(found, 'NOT_FOUND', 'Un producto de la venta no existe en esta sucursal.', 404);
    const amount = (BigInt(quantity) * BigInt(price) + 500n) / 1000n;
    total += amount;
    return { line: index + 1, product, quantity, price, amount, ...found };
  });
  const received = cents(p.received_cents);
  assert(
    total > 0n && cents(p.total_cents) === total,
    'INVALID_SALE',
    'El total no coincide con los productos de la venta.',
    400,
  );
  assert(
    payment === 'cash' ? received >= total : received === total,
    'INVALID_SALE',
    'El pago recibido no cubre el total.',
    400,
  );
  const clock = (
    await db.query(
      'SELECT id FROM clock_records WHERE user_id=$1 AND clock_in<=$2 ORDER BY clock_in DESC LIMIT 1',
      [c.actor_user_id, c.occurred_at],
    )
  ).rows[0];
  await db.query(
    'INSERT INTO sales(branch_id,id,user_id,register_number,clock_record_id,payment,total_cents,received_cents,change_cents,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      branch.id,
      id,
      c.actor_user_id,
      z.coerce.number().int().positive().max(100).parse(p.register_number),
      clock?.id ?? null,
      payment,
      total.toString(),
      received.toString(),
      (received - total).toString(),
      c.occurred_at,
    ],
  );
  await db.query(
    `INSERT INTO sale_items(branch_id,sale_id,line,product_id,clave,description,quantity_milli,unit_price_cents,total_cents)
     SELECT $1,$2,* FROM unnest($3::int[],$4::uuid[],$5::text[],$6::text[],$7::bigint[],$8::bigint[],$9::bigint[])`,
    [
      branch.id,
      id,
      lines.map((l) => l.line),
      lines.map((l) => l.product),
      lines.map((l) => l.clave),
      lines.map((l) => l.description),
      lines.map((l) => l.quantity),
      lines.map((l) => l.price),
      lines.map((l) => l.amount.toString()),
    ],
  );
}
// What each refresh of the screen carries: the catalog version and the user's own recent sales,
// enough for the "ventas del turno" summary without sending every ticket.
export async function salesSnapshot(db: pg.PoolClient, userId: string) {
  if (!(await salesReady(db))) return {};
  const catalog = (
    await db.query('SELECT version::int AS version,product_count,imported_at FROM product_catalogs')
  ).rows[0];
  return {
    catalog: catalog ?? { version: 0, product_count: 0, imported_at: null },
    sales: (
      await db.query(
        `SELECT id,register_number,payment,total_cents::text,occurred_at FROM sales
         WHERE user_id=$1 AND occurred_at>=now()-interval '24 hours' ORDER BY occurred_at,id`,
        [userId],
      )
    ).rows,
  };
}
