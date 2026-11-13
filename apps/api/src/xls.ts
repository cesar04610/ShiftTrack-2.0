import { assert, AppError } from '../../../packages/domain/index.js';

// Minimal reader for the legacy Excel format (.xls, BIFF8 inside a compound file), which is what
// SICAR exports. It returns the cells of the first worksheet and nothing else: no formulas,
// styles or other sheets. Every offset is bounds-checked because the file comes from an upload.
export type XlsCell = string | number | undefined;

const MAX_ROWS = 50_000,
  MAX_COLUMNS = 256;
function invalid(
  message = 'No se pudo leer el archivo. Expórtalo de nuevo desde SICAR en .xls.',
): never {
  throw new AppError('INVALID_EXCEL', message, 400);
}

function workbookStream(file: Buffer): Buffer {
  assert(
    file.length >= 1536 &&
      file.readUInt32BE(0) === 0xd0cf11e0 &&
      file.readUInt32BE(4) === 0xa1b11ae1,
    'INVALID_EXCEL',
    'Selecciona el archivo .xls que exporta SICAR.',
    400,
  );
  const shift = file.readUInt16LE(30),
    miniShift = file.readUInt16LE(32);
  if ((shift !== 9 && shift !== 12) || miniShift !== 6) invalid();
  const size = 1 << shift,
    sectors = Math.ceil(file.length / size);
  const sector = (n: number) => {
    const start = (n + 1) * size;
    if (n < 0 || start >= file.length) invalid();
    return file.subarray(start, Math.min(start + size, file.length));
  };
  // Sector allocation table: the header lists the first 109 of its sectors, the rest are chained.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const n = file.readInt32LE(76 + i * 4);
    if (n >= 0) fatSectors.push(n);
  }
  let next = file.readInt32LE(68);
  for (let guard = 0; next >= 0; guard++) {
    if (guard > sectors) invalid();
    const s = sector(next);
    for (let i = 0; i + 8 <= s.length; i += 4) {
      const n = s.readInt32LE(i);
      if (n >= 0) fatSectors.push(n);
    }
    next = s.length >= size ? s.readInt32LE(size - 4) : -2;
  }
  if (fatSectors.length > sectors) invalid();
  const fat: number[] = [];
  for (const n of fatSectors) {
    const s = sector(n);
    for (let i = 0; i + 4 <= s.length; i += 4) fat.push(s.readInt32LE(i));
  }
  const chain = (start: number, table: number[], limit: number) => {
    const list: number[] = [];
    for (let n = start; n >= 0; n = table[n] ?? -2) {
      if (list.length > limit) invalid();
      list.push(n);
    }
    return list;
  };
  const read = (start: number, length?: number) => {
    const data = Buffer.concat(chain(start, fat, sectors).map(sector));
    if (length !== undefined && data.length < length) invalid();
    return length === undefined ? data : data.subarray(0, length);
  };
  const directory = read(file.readInt32LE(48));
  let root: { start: number; length: number } | undefined,
    book: { start: number; length: number } | undefined;
  for (let i = 0; i + 128 <= directory.length; i += 128) {
    const nameLength = directory.readUInt16LE(i + 64),
      type = directory[i + 66];
    if (nameLength < 2 || nameLength > 64) continue;
    const name = directory.toString('utf16le', i, i + nameLength - 2);
    const entry = {
      start: directory.readInt32LE(i + 116),
      length: directory.readUInt32LE(i + 120),
    };
    if (type === 5) root = entry;
    else if (type === 2 && (name === 'Workbook' || (name === 'Book' && !book))) book = entry;
  }
  if (!book) return invalid();
  if (book.length >= file.readUInt32LE(56)) return read(book.start, book.length);
  // Small streams live in the mini stream, which is itself stored in the root entry.
  if (!root) return invalid();
  const mini = read(root.start),
    miniFat: number[] = [],
    miniFatData = read(file.readInt32LE(60));
  for (let i = 0; i + 4 <= miniFatData.length; i += 4) miniFat.push(miniFatData.readInt32LE(i));
  const parts = chain(book.start, miniFat, mini.length / 64 + 1).map((n) => {
    if ((n + 1) * 64 > mini.length) invalid();
    return mini.subarray(n * 64, (n + 1) * 64);
  });
  const data = Buffer.concat(parts);
  if (data.length < book.length) invalid();
  return data.subarray(0, book.length);
}

// The shared string table is split across CONTINUE records; text that crosses a boundary restarts
// with its own encoding byte, while formatting data crosses it unchanged.
function sharedStrings(segments: Buffer[]): string[] {
  let index = 0,
    offset = 8;
  const first = segments[0];
  if (!first || first.length < 8) return [];
  const count = first.readUInt32LE(4),
    strings: string[] = [];
  if (count > 2_000_000) invalid();
  const available = () => {
    while (index < segments.length && offset >= segments[index].length) {
      index++;
      offset = 0;
    }
    if (index >= segments.length) invalid();
    return segments[index].length - offset;
  };
  const bytes = (length: number) => {
    const parts: Buffer[] = [];
    while (length > 0) {
      const take = Math.min(length, available());
      parts.push(segments[index].subarray(offset, offset + take));
      offset += take;
      length -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  };
  for (let i = 0; i < count; i++) {
    let remaining = bytes(2).readUInt16LE(0),
      flags = bytes(1)[0];
    const runs = flags & 8 ? bytes(2).readUInt16LE(0) : 0,
      extra = flags & 4 ? bytes(4).readUInt32LE(0) : 0;
    let text = '';
    while (remaining > 0) {
      if (offset >= segments[index].length) {
        index++;
        offset = 0;
        if (index >= segments.length) invalid();
        flags = (flags & ~1) | (segments[index][offset++] & 1);
      }
      const wide = flags & 1,
        take = Math.min(remaining, Math.floor((segments[index].length - offset) / (wide ? 2 : 1)));
      if (take <= 0) invalid();
      const end = offset + take * (wide ? 2 : 1);
      text += segments[index].toString(wide ? 'utf16le' : 'latin1', offset, end);
      offset = end;
      remaining -= take;
    }
    if (runs * 4 + extra) bytes(runs * 4 + extra);
    strings.push(text);
  }
  return strings;
}

function rk(value: number) {
  const number =
    value & 2
      ? value >> 2
      : (() => {
          const b = Buffer.alloc(8);
          b.writeInt32LE(value & ~3, 4);
          return b.readDoubleLE(0);
        })();
  return value & 1 ? number / 100 : number;
}

export function readXls(file: Buffer): XlsCell[][] {
  const book = workbookStream(file);
  const records = function* (start: number) {
    for (let at = start; at + 4 <= book.length;) {
      const id = book.readUInt16LE(at),
        length = book.readUInt16LE(at + 2);
      if (at + 4 + length > book.length) invalid();
      yield { id, data: book.subarray(at + 4, at + 4 + length) };
      at += 4 + length;
    }
  };
  let strings: string[] = [],
    sheetAt = -1,
    table: Buffer[] | null = null,
    started = false;
  for (const { id, data } of records(0)) {
    if (!started) {
      // Only Excel 97-2003 workbooks (BIFF8) are supported.
      if (id !== 0x809 || data.length < 4 || data.readUInt16LE(0) !== 0x600) invalid();
      started = true;
      continue;
    }
    if (id === 0x2f) invalid('El archivo tiene contraseña. Expórtalo de SICAR sin protección.');
    if (id === 0x3c && table) table.push(data);
    else {
      if (table) {
        strings = sharedStrings(table);
        table = null;
      }
      if (id === 0xfc) table = [data];
      else if (id === 0x85 && sheetAt < 0 && data.length >= 6 && data[5] === 0)
        sheetAt = data.readUInt32LE(0);
      else if (id === 0x0a) break;
    }
  }
  if (table) strings = sharedStrings(table);
  if (sheetAt < 0 || sheetAt >= book.length) invalid();
  const rows: XlsCell[][] = [];
  const put = (row: number, column: number, value: XlsCell) => {
    assert(
      row < MAX_ROWS && column < MAX_COLUMNS,
      'EXCEL_TOO_LARGE',
      `El archivo tiene demasiadas filas o columnas (máximo ${MAX_ROWS.toLocaleString('es-MX')} productos).`,
      400,
    );
    (rows[row] ??= [])[column] = value;
  };
  started = false;
  for (const { id, data } of records(sheetAt)) {
    if (!started) {
      if (id !== 0x809) invalid();
      started = true;
      continue;
    }
    if (id === 0x0a) break;
    if (data.length < 6) continue;
    const row = data.readUInt16LE(0),
      column = data.readUInt16LE(2);
    if (id === 0xfd && data.length >= 10) put(row, column, strings[data.readUInt32LE(6)] ?? '');
    else if (id === 0x203 && data.length >= 14) put(row, column, data.readDoubleLE(6));
    else if (id === 0x27e && data.length >= 10) put(row, column, rk(data.readInt32LE(6)));
    else if (id === 0xbd)
      for (let at = 4, c = column; at + 6 <= data.length - 2; at += 6, c++)
        put(row, c, rk(data.readInt32LE(at + 2)));
    else if (id === 0x204 && data.length >= 9) {
      const length = data.readUInt16LE(6),
        wide = data[8] & 1;
      if (9 + length * (wide ? 2 : 1) > data.length) invalid();
      put(row, column, data.toString(wide ? 'utf16le' : 'latin1', 9, 9 + length * (wide ? 2 : 1)));
    } else if (id === 0x06 && data.length >= 14 && data.readUInt16LE(12) !== 0xffff)
      put(row, column, data.readDoubleLE(6));
  }
  return rows;
}
