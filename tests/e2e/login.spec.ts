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

test('empleado creado por administrador prepara un equipo nuevo y vuelve a entrar offline', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const ownerLogin = await page.request.post(`${apiBase}/api/v1/auth/login`, {
    data: { username: 'cesar', password },
  });
  expect(ownerLogin.ok()).toBeTruthy();
  const ownerHeaders = { Authorization: `Bearer ${(await ownerLogin.json()).access_token}` };
  const branches: { id: string }[] = [];
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
  await signIn(page, employeeUsername);
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Horario', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Acceso offline preparado', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Caja proveedores', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Proveedores', exact: true })).toHaveCount(0);
  // A live second tab must not revoke the first one's lease.
  const competing = await context.newPage();
  await competing.goto('/');
  await signIn(competing, employeeUsername);
  await competing.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await competing.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(competing.getByRole('alert')).toContainText('Otra pestaña');
  await competing.close();
  // Normal navigation sends the close notification, releases the register and requires login.
  expect(await page.evaluate(() => sessionStorage.getItem('shifttrack-session-v1')?.length)).toBe(
    43,
  );
  await page.reload();
  await expect
    .poll(async () => {
      const response = await context.request.get(
        `${apiBase}/api/v1/registers?branch_id=${branches[1].id}`,
        { headers: ownerHeaders },
      );
      return (await response.json()).length;
    })
    .toBe(0);
  await page.goto('/');
  await signIn(page, employeeUsername);
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Horario', exact: true, level: 1 })).toBeVisible();
  // Missed close notification (offline) also recovers the same user's box on reconnection.
  await context.setOffline(true);
  await page.goto('about:blank');
  await context.setOffline(false);
  await page.goto('/');
  await signIn(page, employeeUsername);
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Horario', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.route('**/api/v1/auth/login', (route) => route.abort());
  await signIn(page, employeeUsername);
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Horario', exact: true, level: 1 })).toBeVisible();
});
