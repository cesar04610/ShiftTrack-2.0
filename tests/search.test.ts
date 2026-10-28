import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../apps/web/src/SearchSelect.tsx';

const suppliers = [
  { value: '1', label: 'Leche Zaragoza', hint: 'Lácteos' },
  { value: '2', label: 'Zarate Abarrotes' },
  { value: '3', label: 'Bazar del Norte' },
  { value: '4', label: 'Tortillas Delicias' },
  { value: '5', label: 'Café Ámbar' },
];
const names = (text: string) => search(suppliers, text).map((s) => s.label);

test('el buscador de proveedores pone primero lo que empieza con el texto', () => {
  assert.deepEqual(names('zar'), ['Zarate Abarrotes', 'Leche Zaragoza', 'Bazar del Norte']);
  assert.deepEqual(names('ZAR'), names('zar'));
  assert.deepEqual(names('cafe'), ['Café Ámbar']);
  assert.deepEqual(names('ambar'), ['Café Ámbar']);
  assert.deepEqual(names('lacteos'), ['Leche Zaragoza']);
  assert.deepEqual(names('xyz'), []);
  assert.equal(names('').length, 5);
});
