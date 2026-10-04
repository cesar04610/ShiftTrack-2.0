import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
const api = process.env.E2E_API_URL || 'http://127.0.0.1:8080';
test('importar proveedores desde Excel: vista previa, errores, duplicados y directorio actualizado', async ({
  page,
}) => {
  const login = await page.request.post(`${api}/api/v1/auth/login`, {
    data: { username: 'cesar', password: 'ShiftTrack-demo-2026!' },
  });
  const session = await login.json(),
    branchName = `Excel ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${api}/api/v1/branches`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    data: { name: branchName, register_count: 3, supplier_register: 3 },
  });
  const branch = await created.json();
  expect(created.ok()).toBeTruthy();
  await page.goto('/');
  await page.getByLabel('Usuario', { exact: true }).fill('cesar');
  await page.getByLabel('Contraseña', { exact: true }).fill('ShiftTrack-demo-2026!');
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByLabel('Sucursal', { exact: true }).selectOption(branch.id);
  await page.getByRole('button', { name: 'Continuar sin caja', exact: true }).click();
  await page.getByRole('button', { name: 'Caja proveedores', exact: true }).click();
  await page.getByRole('button', { name: 'Importar proveedores desde Excel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Importar proveedores desde Excel' });
  await expect(dialog).toContainText(branchName);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Descargar plantilla Excel' }).click();
  expect((await download).suggestedFilename()).toBe('plantilla-proveedores.xlsx');
  async function file(rows: any[][]) {
    const b = new ExcelJS.Workbook(),
      s = b.addWorksheet('Proveedores');
    s.addRow(['Empresa', 'Representante', 'Teléfono', 'Tipo de producto']);
    rows.forEach((r) => s.addRow(r));
    return {
      name: 'proveedores.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await b.xlsx.writeBuffer()),
    };
  }
  await dialog.getByLabel('Archivo Excel', { exact: false }).setInputFiles(
    await file([
      ['Proveedor Excel', 'Ana', '00123', 'Bebidas'],
      ['', '', '99', ''],
    ]),
  );
  await dialog.getByRole('button', { name: 'Revisar archivo' }).click();
  await expect(
    dialog.getByText(
      'Corrige las filas señaladas en Excel y vuelve a cargar el archivo para poder importar.',
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Importar 1 proveedor', exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel('Archivo Excel', { exact: false }).setInputFiles(
    await file([
      ['Proveedor Excel', 'Ana', '00123', 'Bebidas'],
      ['PROVEEDOR EXCEL', '', '', ''],
    ]),
  );
  await dialog.getByRole('button', { name: 'Revisar archivo' }).click();
  await expect(dialog).toContainText('1 repetidos y 0 con errores');
  await dialog.getByRole('button', { name: 'Importar 1 proveedor', exact: true }).click();
  await expect(dialog.getByText('Registro guardado correctamente.', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('Proveedores agregados: 1. Repetidos omitidos: 1.');
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Proveedor Excel', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '00123', exact: true })).toBeVisible();
});
