import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseMoney, cutAmounts, shiftLabel, canonical } from '../packages/domain/index.js';
test('centavos exactos y diferencias sin coma flotante', () => {
  assert.equal(parseMoney('123.09'), '12309');
  assert.equal(parseMoney('9000000000.01'), '900000000001');
  assert.deepEqual(cutAmounts('100000', '20000', '79000'), {
    expected: '80000',
    difference: '-1000',
  });
  assert.throws(() => parseMoney('1.001'));
  assert.throws(() => cutAmounts('100', '200', '0'));
});
test('etiqueta en límites originales de la sucursal', () => {
  assert.equal(shiftLabel('2026-10-03T14:29:59Z', 'America/Mazatlan'), 'Tarde');
  assert.equal(shiftLabel('2026-10-03T14:30:00Z', 'America/Mazatlan'), 'Mañana');
  assert.equal(shiftLabel('2026-10-03T23:59:59Z', 'America/Mazatlan'), 'Mañana');
  assert.equal(shiftLabel('2026-10-04T00:00:00Z', 'America/Mazatlan'), 'Tarde');
});
test('serialización canónica estable entre navegador y servidor', () => {
  assert.equal(
    canonical({ z: [{ b: 2, a: 1 }], a: 'á' }),
    canonical({ a: 'á', z: [{ a: 1, b: 2 }] }),
  );
});
