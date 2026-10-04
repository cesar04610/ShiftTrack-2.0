import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const password = 'ShiftTrack-demo-2026!';
const apiBase = process.env.E2E_API_URL || 'http://127.0.0.1:8080';
async function login(page: Page, username: string, branch?: string) {
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  if (branch) {
    await page.getByLabel('Sucursal de trabajo', { exact: true }).selectOption(branch);
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Cerrar sesión', exact: true })).toBeVisible();
}
async function box(page: Page) {
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Horario', exact: true, level: 1 })).toBeVisible();
}
test('Jenny trabaja en dos sucursales online y offline; eliminarla conserva historial y libera su nombre', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 8),
    username = `jenny-${suffix}`;
  const owner = await page.request.post(`${apiBase}/api/v1/auth/login`, {
    data: { username: 'cesar', password },
  });
  const headers = { Authorization: `Bearer ${(await owner.json()).access_token}` };
  const accounts: { branch: string; id: string; name: string }[] = [];
  for (const shop of ['Quates', 'Madeira']) {
    const name = `${shop} ${suffix}`;
    const b = await page.request.post(`${apiBase}/api/v1/branches`, {
      headers,
      data: { name, register_count: 3, supplier_register: 3 },
    });
    expect(b.status()).toBe(201);
    const branch = (await b.json()).id;
    const u = await page.request.post(`${apiBase}/api/v1/users`, {
      headers,
      data: { branch_id: branch, username, name: 'Jenny', role: 'employee', password },
    });
    expect(u.status()).toBe(201);
    accounts.push({ branch, id: (await u.json()).id, name });
  }
  await page.goto('/');
  for (const a of accounts) {
    await login(page, username, a.branch);
    await box(page);
    await expect(page.locator('.topbar')).toContainText(a.name);
    await page.getByRole('button', { name: 'Registro de entradas', exact: true }).click();
    await page.getByRole('button', { name: 'Registrar entrada', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Registrar salida', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  for (const a of accounts) {
    await login(page, username, a.branch);
    await box(page);
    await expect(page.locator('.topbar')).toContainText(a.name);
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  }
  await context.setOffline(false);
  expect(
    (
      await page.request.post(`${apiBase}/api/v1/users/${accounts[0].id}/deactivate`, {
        headers,
        data: { branch_id: accounts[0].branch },
      })
    ).ok(),
  ).toBeTruthy();
  await login(page, 'cesar');
  await page.getByLabel('Sucursal', { exact: true }).selectOption(accounts[0].branch);
  await page.getByRole('button', { name: 'Usuarios', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: username });
  await expect(row).toContainText('Inactivo');
  await row.getByRole('button', { name: 'Eliminar empleado', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await expect(row).toHaveCount(0);
  const history = await page.request.get(
    `${apiBase}/api/v1/snapshot?branch_id=${accounts[0].branch}`,
    { headers },
  );
  const data = await history.json();
  expect(data.clock).toHaveLength(1);
  expect(data.users.find((u: any) => u.id === accounts[0].id).name).toBe('Jenny');
  await page.getByLabel('Nombre', { exact: true }).fill('Jenny nueva');
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Rol', { exact: true }).selectOption('employee');
  await page
    .getByLabel('Contraseña inicial · mínimo 12 caracteres', { exact: true })
    .fill(password);
  await page.getByRole('button', { name: 'Crear usuario', exact: true }).click();
  await expect(row).toContainText('Jenny nueva');
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await login(page, username, accounts[1].branch);
  await box(page);
  await expect(page.locator('.topbar')).toContainText(accounts[1].name);
});
