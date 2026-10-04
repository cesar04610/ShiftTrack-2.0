import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const password = 'ShiftTrack-demo-2026!';
const apiBase = process.env.E2E_API_URL || 'http://127.0.0.1:8080';
async function signIn(page: Page, username: string) {
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión', exact: true })).toBeVisible();
}
async function selectBox(page: Page, number: number) {
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption(String(number));
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
}
test('configurar tres cajas, impedir ocupación duplicada y eliminar con contraseña', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8),
    branchName = `Madeira ${suffix}`;
  const login = await page.request.post(`${apiBase}/api/v1/auth/login`, {
    data: { username: 'cesar', password },
  });
  expect(login.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await login.json()).access_token}` };
  await page.goto('/');
  await signIn(page, 'cesar');
  await page.getByRole('button', { name: 'Configuración', exact: true }).click();
  await page.getByLabel('Nombre de sucursal', { exact: true }).fill(branchName);
  await page.getByLabel('Cantidad de cajas', { exact: true }).fill('3');
  await page.getByLabel('Caja de proveedores', { exact: true }).selectOption('3');
  const createdResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/branches') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Crear sucursal', exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const branch = await created.json();
  await page.getByLabel('Sucursal', { exact: true }).selectOption(branch.id);
  const first = `lupe-${suffix}`,
    second = `jenny-${suffix}`;
  for (const username of [first, second]) {
    const user = await page.request.post(`${apiBase}/api/v1/users`, {
      headers,
      data: { username, name: username, role: 'employee', branch_id: branch.id, password },
    });
    expect(user.status()).toBe(201);
  }
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await signIn(page, first);
  await expect(
    page.getByRole('heading', { name: 'Selecciona la caja en la que estás', exact: true }),
  ).toBeVisible();
  await selectBox(page, 2);
  await expect(page.getByRole('heading', { name: 'Horario', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Caja proveedores', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Proveedores', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Registro de entradas', exact: true }),
  ).toBeVisible();
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto('/');
  await signIn(otherPage, second);
  await selectBox(otherPage, 2);
  await expect(otherPage.getByRole('alert')).toContainText('ya está ocupada');
  await selectBox(otherPage, 1);
  await expect(
    otherPage.getByRole('heading', { name: 'Horario', exact: true, level: 1 }),
  ).toBeVisible();
  await otherPage.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await other.close();
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await signIn(page, first);
  await selectBox(page, 3);
  await expect(page.getByRole('button', { name: 'Caja proveedores', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Registro de entradas', exact: true }).click();
  await page.getByRole('button', { name: 'Registrar entrada', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Registrar salida', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mi corte', exact: true }).click();
  await expect(page.getByLabel('Horario vinculado · opcional')).toHaveCount(0);
  await page.getByLabel('Ventas totales · MXN').fill('100');
  await page.getByLabel('Pagos con tarjeta · MXN').fill('20');
  await page.getByLabel('Efectivo contado de ventas · MXN').fill('80');
  await page.getByRole('button', { name: 'Guardar corte', exact: true }).click();
  await expect(page.getByRole('cell', { name: '$100.00', exact: true })).toBeVisible();
  await expect(page.locator('.pending-panel')).toHaveCount(0, { timeout: 20000 });
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await signIn(page, 'cesar');
  await page.getByLabel('Sucursal', { exact: true }).selectOption(branch.id);
  await page.getByRole('button', { name: 'Configuración', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: branchName })
    .getByRole('button', { name: 'Eliminar sucursal', exact: true })
    .click();
  await expect(
    page.getByText('¿Realmente quieres eliminar esta sucursal?', { exact: false }),
  ).toBeVisible();
  await page.getByLabel('Tu contraseña de superadministrador', { exact: true }).fill('incorrecta');
  await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Contraseña incorrecta');
  await page.getByLabel('Tu contraseña de superadministrador', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: branchName })).toContainText(
    'historial conservado',
  );
});
