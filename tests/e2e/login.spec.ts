import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const password = 'ShiftTrack-demo-2026!';
const apiBase = process.env.E2E_API_URL || 'http://127.0.0.1:8080';

async function signIn(page: Page, username: string) {
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
}

test('empleado creado por administrador entra online desde un equipo de otra sucursal', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const ownerLogin = await page.request.post(`${apiBase}/api/v1/auth/login`, {
    data: { username: 'cesar', password },
  });
  expect(ownerLogin.ok()).toBeTruthy();
  const ownerHeaders = { Authorization: `Bearer ${(await ownerLogin.json()).access_token}` };
  const branches = [];
  for (const name of [`Equipo ${suffix}`, `Empleado ${suffix}`]) {
    const response = await page.request.post(`${apiBase}/api/v1/branches`, {
      headers: ownerHeaders,
      data: { name, register_count: 2, supplier_register: 1 },
    });
    expect(response.ok()).toBeTruthy();
    branches.push(await response.json());
  }
  const adminUsername = `admin-${suffix}`;
  const employeeUsername = `jenny-${suffix}`;
  const adminCreated = await page.request.post(`${apiBase}/api/v1/users`, {
    headers: ownerHeaders,
    data: {
      username: adminUsername,
      name: 'Administrador prueba',
      role: 'admin',
      branch_id: branches[1].id,
      password,
    },
  });
  expect(adminCreated.ok()).toBeTruthy();
  const adminLogin = await page.request.post(`${apiBase}/api/v1/auth/login`, {
    data: { username: adminUsername, password },
  });
  expect(adminLogin.ok()).toBeTruthy();
  const employeeCreated = await page.request.post(`${apiBase}/api/v1/users`, {
    headers: { Authorization: `Bearer ${(await adminLogin.json()).access_token}` },
    data: {
      username: employeeUsername,
      name: 'Jenny prueba',
      role: 'employee',
      branch_id: branches[1].id,
      password,
    },
  });
  expect(employeeCreated.ok()).toBeTruthy();
  await page.goto('/');
  await signIn(page, 'cesar');
  await page.getByLabel('Sucursal').selectOption(branches[0].id);
  await page.getByRole('button', { name: 'Configuración', exact: true }).click();
  await page.getByLabel('Nombre del equipo', { exact: true }).fill('Equipo otra sucursal');
  await page.getByRole('button', { name: 'Registrar este equipo', exact: true }).click();
  await expect(
    page.getByText('La sucursal ya tiene equipo designado.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  await signIn(page, employeeUsername);
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Horario', exact: true, level: 1 })).toBeVisible();
  await expect(
    page.getByText('Este equipo aún no tiene tu acceso offline preparado.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Acceso preparado hasta', { exact: false })).toHaveCount(0);
  // An online-only login must release the operational tab lock.
  const otherPage = await context.newPage();
  await otherPage.goto('/');
  await signIn(otherPage, employeeUsername);
  await otherPage.getByLabel('Selecciona tu caja', { exact: true }).selectOption('2');
  await otherPage.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(
    otherPage.getByRole('heading', { name: 'Horario', exact: true, level: 1 }),
  ).toBeVisible();
  await otherPage.close();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.route('**/api/v1/auth/login', (route) => route.abort());
  await page.getByLabel('Usuario', { exact: true }).fill(employeeUsername);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('necesita iniciar sesión con conexión');
});
