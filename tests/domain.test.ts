import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseMoney,
  cutAmounts,
  shiftLabel,
  shiftBusinessDate,
  canonical,
} from '../packages/domain/index.js';
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
test('turno y fecha según entrada, con tarde desde las 15:00', () => {
  const tz = 'America/Mazatlan';
  assert.equal(shiftLabel('2026-10-03T11:59:59Z', tz), 'Tarde');
  assert.equal(shiftLabel('2026-10-03T12:00:00Z', tz), 'Mañana');
  assert.equal(shiftLabel('2026-10-03T21:59:59Z', tz), 'Mañana');
  assert.equal(shiftLabel('2026-10-03T22:00:00Z', tz), 'Tarde');
  assert.equal(shiftBusinessDate('2026-10-04T11:30:00Z', tz), '2026-10-03');
  assert.equal(shiftBusinessDate('2026-10-04T12:00:00Z', tz), '2026-10-04');
});
test('serialización canónica estable entre navegador y servidor', () => {
  assert.equal(
    canonical({ z: [{ b: 2, a: 1 }], a: 'á' }),
    canonical({ a: 'á', z: [{ a: 1, b: 2 }] }),
  );
});
