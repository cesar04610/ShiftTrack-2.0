import express from 'express';
import ExcelJS from 'exceljs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assert } from '../../../packages/domain/index.js';
import { identity } from './security.js';
import { admin, context, transaction } from './db.js';

const MAX_ROWS = 2000;
const normalized = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
type Supplier = { company: string; representative: string; phone: string; product_type: string };
type ImportRow = Supplier & {
  row: number;
  status: 'new' | 'duplicate' | 'invalid';
  message: string;
};
const aliases = {
  company: ['empresa', 'company', 'company_name'],
  representative: ['representante', 'representative', 'rep_name'],
  phone: ['telefono', 'phone', 'rep_phone'],
  product_type: ['tipo de producto', 'producto', 'product_type'],
};

// Bound decompression before ExcelJS opens the workbook. Reject ZIP64/encrypted archives.
function validateArchive(buffer: Buffer) {
  assert(
    buffer.length >= 22 && buffer.readUInt32LE(0) === 0x04034b50,
    'INVALID_EXCEL',
    'Selecciona un archivo Excel .xlsx válido.',
    400,
  );
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  assert(end >= 0, 'INVALID_EXCEL', 'No se pudo leer el archivo Excel.', 400);
  const count = buffer.readUInt16LE(end + 10),
    offset = buffer.readUInt32LE(end + 16);
  assert(
    count <= 500 && offset < end,
    'INVALID_EXCEL',
    'El archivo Excel es demasiado complejo. Usa la plantilla de proveedores.',
    400,
  );
  let cursor = offset,
    size = 0;
  for (let i = 0; i < count; i++) {
    assert(
      cursor + 46 <= end && buffer.readUInt32LE(cursor) === 0x02014b50,
      'INVALID_EXCEL',
      'No se pudo leer el archivo Excel.',
      400,
    );
    const flags = buffer.readUInt16LE(cursor + 8),
      expanded = buffer.readUInt32LE(cursor + 24);
    assert(
      !(flags & 1) && expanded !== 0xffffffff,
      'INVALID_EXCEL',
      'Usa un Excel .xlsx sin contraseña.',
      400,
    );
    size += expanded;
    assert(
      size <= 20 * 1024 * 1024,
      'EXCEL_TOO_LARGE',
      'El archivo contiene demasiados datos. Usa solo la hoja de proveedores.',
      400,
    );
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
  assert(cursor === end, 'INVALID_EXCEL', 'No se pudo leer el archivo Excel.', 400);
}
function text(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'INVALID_CELL', 'Usa texto o números válidos.', 400);
    return /^0+$/.test(cell.numFmt)
      ? String(value).padStart(cell.numFmt.length, '0')
      : String(value);
  }
  if (typeof value === 'object' && 'richText' in value)
    return value.richText
      .map((part) => part.text)
      .join('')
      .trim();
  if (typeof value === 'object' && 'hyperlink' in value) return value.text.trim();
  assert(
    false,
    'INVALID_CELL',
    'Usa valores de texto; quita fórmulas, fechas y errores de estas celdas.',
    400,
  );
}
export async function parseSuppliers(buffer: Buffer) {
  validateArchive(buffer);
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(buffer as any);
  } catch {
    assert(
      false,
      'INVALID_EXCEL',
      'No se pudo leer el archivo. Guárdalo como Excel .xlsx e inténtalo otra vez.',
      400,
    );
  }
  const sheet =
    book.worksheets.find((s) => ['proveedores', 'suppliers'].includes(normalized(s.name))) ||
    book.worksheets[0];
  assert(
    sheet && sheet.columnCount <= 50 && sheet.rowCount <= MAX_ROWS + 1,
    'EXCEL_TOO_LARGE',
    `Usa una hoja con hasta ${MAX_ROWS} proveedores y los encabezados en la primera fila.`,
    400,
  );
  const columns: Partial<Record<keyof Supplier, number>> = {};
  sheet.getRow(1).eachCell((cell, column) => {
    const header = normalized(text(cell));
    for (const [key, names] of Object.entries(aliases))
      if (names.includes(header)) {
        assert(
          !columns[key as keyof Supplier],
          'INVALID_HEADERS',
          `La columna ${header} está repetida.`,
          400,
        );
        columns[key as keyof Supplier] = column;
      }
  });
  assert(
    columns.company,
    'INVALID_HEADERS',
    'Falta la columna Empresa en la primera fila. Puedes descargar la plantilla.',
    400,
  );
  const rows: ImportRow[] = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    const line = sheet.getRow(index);
    if (
      Object.values(columns).every(
        (column) => line.getCell(column!).value == null || line.getCell(column!).value === '',
      )
    )
      continue;
    const values: Supplier = { company: '', representative: '', phone: '', product_type: '' };
    let message = '';
    try {
      for (const key of Object.keys(values) as (keyof Supplier)[]) {
        values[key] = columns[key] ? text(line.getCell(columns[key]!)) : '';
        const maximum = key === 'phone' ? 60 : 200;
        assert(
          values[key].length <= maximum,
          'INVALID_CELL',
          `${key === 'phone' ? 'Teléfono' : 'El campo'} supera ${maximum} caracteres.`,
          400,
        );
      }
      assert(values.company, 'INVALID_CELL', 'Escribe el nombre de la empresa.', 400);
    } catch (error) {
      message = (error as Error).message;
    }
    rows.push({ ...values, row: index, status: message ? 'invalid' : 'new', message });
  }
  assert(
    rows.length,
    'EMPTY_EXCEL',
    'El archivo no contiene proveedores. Agrega los datos debajo de los encabezados.',
    400,
  );
  return { sheet: sheet.name, rows };
}
function preview(rows: ImportRow[], existing: { company: string }[]) {
  const seen = new Set(existing.map((r) => normalized(r.company)));
  return rows.map((row) => {
    if (row.status === 'invalid') return { ...row };
    const company = normalized(row.company);
    if (seen.has(company))
      return {
        ...row,
        status: 'duplicate' as const,
        message: 'Empresa repetida; no se agregará ni se cambiarán sus datos.',
      };
    seen.add(company);
    return { ...row };
  });
}
const summary = (rows: ImportRow[]) => ({
  total: rows.length,
  new: rows.filter((r) => r.status === 'new').length,
  duplicate: rows.filter((r) => r.status === 'duplicate').length,
  invalid: rows.filter((r) => r.status === 'invalid').length,
});
export const supplierImport = express.Router();
supplierImport.use(async (req, _res, next) => {
  admin(await identity(req.headers.authorization));
  next();
});
supplierImport.get('/template', async (req, res) => {
  const user = await identity(req.headers.authorization);
  await context(user, req.query.branch_id as string);
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Proveedores');
  sheet.columns = [
    { header: 'Empresa', key: 'company', width: 35 },
    { header: 'Representante', key: 'representative', width: 30 },
    { header: 'Teléfono', key: 'phone', width: 24 },
    { header: 'Tipo de producto', key: 'product_type', width: 30 },
  ];
  sheet.getColumn(3).numFmt = '@';
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-proveedores.xlsx"');
  await book.xlsx.write(res);
  res.end();
});
supplierImport.post(
  '/',
  express.raw({
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    limit: '2mb',
  }),
  async (req, res) => {
    const user = await identity(req.headers.authorization),
      branch = await context(user, req.query.branch_id as string);
    const input = z
      .object({
        mode: z.enum(['preview', 'confirm']),
        operation_id: z.uuid().optional(),
        preview_hash: z.string().length(64).optional(),
      })
      .parse(req.query);
    assert(Buffer.isBuffer(req.body), 'INVALID_EXCEL', 'Selecciona un archivo Excel .xlsx.', 400);
    const hash = createHash('sha256').update(req.body).digest('hex');
    const parsed = await parseSuppliers(req.body);
    const result = await transaction(branch.id, async (db) => {
      const locked = (
        await db.query('SELECT active FROM branches WHERE id=$1 FOR UPDATE', [branch.id])
      ).rows[0];
      assert(locked?.active, 'BRANCH_INACTIVE', 'Esta sucursal está desactivada.', 403);
      const rows = preview(
        parsed.rows,
        (await db.query('SELECT company FROM suppliers WHERE branch_id=$1', [branch.id])).rows,
      );
      if (input.mode === 'preview')
        return { sheet: parsed.sheet, rows, summary: summary(rows), preview_hash: hash };
      assert(
        input.operation_id && input.preview_hash === hash,
        'PREVIEW_REQUIRED',
        'Revisa primero la vista previa de este archivo.',
        400,
      );
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            type: 'suppliers.import',
            branch: branch.id,
            actor: user.id,
            file: hash,
          }),
        )
        .digest('hex');
      const existing = (
        await db.query('SELECT * FROM processed_operations WHERE id=$1', [input.operation_id])
      ).rows[0];
      if (existing) {
        assert(
          existing.request_hash === requestHash,
          'VERSION_CONFLICT',
          'Esta importación corresponde a otro archivo.',
          409,
        );
        return existing.result;
      }
      assert(
        !rows.some((r) => r.status === 'invalid'),
        'INVALID_ROWS',
        'Corrige las filas señaladas y vuelve a cargar el archivo.',
        400,
      );
      const adding = rows.filter((r) => r.status === 'new');
      for (const row of adding)
        await db.query(
          'INSERT INTO suppliers(branch_id,id,company,representative,phone,product_type) VALUES($1,$2,$3,$4,$5,$6)',
          [branch.id, randomUUID(), row.company, row.representative, row.phone, row.product_type],
        );
      const saved = {
        imported: adding.length,
        skipped: rows.length - adding.length,
        message: 'Registro guardado correctamente.',
      };
      await db.query(
        'INSERT INTO audit_events(branch_id,id,actor_user_id,action,payload) VALUES($1,$2,$3,$4,$5)',
        [
          branch.id,
          randomUUID(),
          user.id,
          'suppliers.import',
          { operation_id: input.operation_id, file_sha256: hash, ...saved },
        ],
      );
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
