// Builds a small legacy Excel file (.xls, BIFF8) like the one SICAR exports, for the tests.
// `recordLimit` shrinks the records so the shared strings spill into CONTINUE records, as they do
// in a real catalog with thousands of products.
export function buildXls(rows: (string | number)[][], recordLimit = 8224): Buffer {
  const record = (id: number, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(id, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  };
  const strings: string[] = [],
    positions = new Map<string, number>();
  let references = 0;
  for (const row of rows)
    for (const cell of row)
      if (typeof cell === 'string') {
        references++;
        if (!positions.has(cell)) positions.set(cell, strings.push(cell) - 1);
      }
  // Shared strings: text may break between records, and the continuation repeats its encoding byte.
  const parts: Buffer[] = [];
  let current: number[] = [];
  const counts = Buffer.alloc(8);
  counts.writeUInt32LE(references, 0);
  counts.writeUInt32LE(strings.length, 4);
  current.push(...counts);
  const flush = () => {
    parts.push(record(parts.length ? 0x3c : 0xfc, Buffer.from(current)));
    current = [];
  };
  for (const text of strings) {
    const wide = [...text].some((c) => c.charCodeAt(0) > 255),
      size = wide ? 2 : 1,
      encoded = Buffer.from(text, wide ? 'utf16le' : 'latin1');
    if (current.length + 3 > recordLimit) flush();
    current.push(text.length & 255, text.length >> 8, wide ? 1 : 0);
    for (let at = 0; at < encoded.length;) {
      let room = Math.floor((recordLimit - current.length) / size) * size;
      if (room <= 0) {
        flush();
        current.push(wide ? 1 : 0);
        room = Math.floor((recordLimit - current.length) / size) * size;
      }
      const take = Math.min(room, encoded.length - at);
      current.push(...encoded.subarray(at, at + take));
      at += take;
    }
  }
  flush();
  const bof = (type: number) => {
    const data = Buffer.alloc(16);
    data.writeUInt16LE(0x600, 0);
    data.writeUInt16LE(type, 2);
    return record(0x809, data);
  };
  const name = Buffer.from('Sheet0', 'latin1'),
    sheet = Buffer.alloc(8 + name.length);
  sheet[6] = name.length;
  name.copy(sheet, 8);
  const globalsLength =
    bof(5).length + 4 + sheet.length + parts.reduce((n, p) => n + p.length, 0) + 4;
  sheet.writeUInt32LE(globalsLength, 0);
  const cells: Buffer[] = [];
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const data = Buffer.alloc(typeof cell === 'string' ? 10 : 14);
      data.writeUInt16LE(r, 0);
      data.writeUInt16LE(c, 2);
      if (typeof cell === 'string') data.writeUInt32LE(positions.get(cell)!, 6);
      else data.writeDoubleLE(cell, 6);
      cells.push(record(typeof cell === 'string' ? 0xfd : 0x203, data));
    }),
  );
  const eof = record(0x0a, Buffer.alloc(0));
  let stream = Buffer.concat([
    bof(5),
    record(0x85, sheet),
    ...parts,
    eof,
    bof(0x10),
    ...cells,
    eof,
  ]);
  const length = stream.length;
  // Padded past 4096 bytes so the stream uses regular 512-byte sectors.
  stream = Buffer.concat([
    stream,
    Buffer.alloc(Math.max(4096, Math.ceil(length / 512) * 512) - length),
  ]);
  const data = stream.length / 512;
  let fatSectors = 1;
  while (fatSectors * 128 < data + 1 + fatSectors) fatSectors++;
  const header = Buffer.alloc(512, 0);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(data, 48);
  header.writeUInt32LE(4096, 56);
  header.writeInt32LE(-2, 60);
  header.writeInt32LE(-2, 68);
  for (let i = 0; i < 109; i++) header.writeInt32LE(i < fatSectors ? data + 1 + i : -1, 76 + i * 4);
  const directory = Buffer.alloc(512, 0);
  const entry = (index: number, label: string, type: number, start: number, size: number) => {
    const at = index * 128;
    directory.write(label, at, 'utf16le');
    directory.writeUInt16LE(label.length * 2 + 2, at + 64);
    directory[at + 66] = type;
    directory[at + 67] = 1;
    directory.writeInt32LE(-1, at + 68);
    directory.writeInt32LE(-1, at + 72);
    directory.writeInt32LE(index === 0 ? 1 : -1, at + 76);
    directory.writeInt32LE(start, at + 116);
    directory.writeUInt32LE(size, at + 120);
  };
  entry(0, 'Root Entry', 5, -2, 0);
  entry(1, 'Workbook', 2, 0, length < 4096 ? 4096 : length);
  const fat = Buffer.alloc(fatSectors * 512, 0xff);
  for (let i = 0; i < data; i++) fat.writeInt32LE(i === data - 1 ? -2 : i + 1, i * 4);
  fat.writeInt32LE(-2, data * 4);
  for (let i = 0; i < fatSectors; i++) fat.writeInt32LE(-3, (data + 1 + i) * 4);
  return Buffer.concat([header, stream, directory, fat]);
}
export const sicarHeaders = [
  'CLAVE',
  'CLAVE ALTERNA',
  'DESCRIPCION',
  'SERVICIO (S/N)',
  'INV_MIN',
  'INV_MAX',
  'PRECIO COMPRA',
  'PRECIO 1',
  'PRECIO 2',
  'MAYOREO 2',
  'PRECIO 3',
  'MAYOREO 3',
  'PRECIO 4',
  'MAYOREO 4',
  'EXIST.',
  'PESO',
  'CARACTERISTICAS',
  'DEPARTAMENTO',
  'CATEGORIA',
  'RECETA (S/N)',
  'GRANEL (S/N)',
  'IMPUESTO (S/N)',
  'IMP IEPS(S/N)',
];
// One SICAR row from the few values the tests care about.
export function sicarRow(
  clave: string,
  alternate: string,
  description: string,
  price: string,
  flags: { bulk?: boolean; vat?: boolean; ieps?: boolean } = {},
) {
  const sn = (value?: boolean) => (value ? 'S' : 'N');
  return [
    clave,
    alternate,
    description,
    'false',
    '0',
    '0',
    '1.000',
    price,
    '0.000000',
    '0.000',
    '0.000000',
    '0.000',
    '0.000000',
    '0.000',
    '5.0000',
    '0.0000',
    '',
    'SIN DEFINIR',
    'SIN DEFINIR',
    'N',
    sn(flags.bulk),
    sn(flags.vat),
    sn(flags.ieps),
  ];
}
export const sicarFile = (rows: string[][], recordLimit?: number) =>
  buildXls([sicarHeaders, ...rows], recordLimit);
