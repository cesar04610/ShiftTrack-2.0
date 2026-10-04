import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
const password = 'ShiftTrack-demo-2026!';
async function signIn(page: Page, username: string) {
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
}
async function nav(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
}
test('dos empleados: preparación, persistencia tras reinicio, relevo offline y sync exacto', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 8),
    branchName = `Piloto ${suffix}`,
    first = `ana-${suffix}`,
    second = `luis-${suffix}`;
  const response = await page.request.post('http://127.0.0.1:8080/api/v1/auth/login', {
    data: { username: 'cesar', password },
  });
  const initial = await response.json();
  const auth = await page.request.post(
    'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-only-key',
    { data: { token: initial.custom_token, returnSecureToken: true } },
  );
  const { idToken } = await auth.json();
  const headers = { Authorization: `Bearer ${idToken}` };
  const created = await page.request.post('http://127.0.0.1:8080/api/v1/branches', {
    headers,
    data: { name: branchName },
  });
  expect(created.ok()).toBeTruthy();
  const branch = await created.json();
  let firstId = '';
  for (const [username, name] of [
    [first, 'Ana prueba'],
    [second, 'Luis prueba'],
  ]) {
    const r = await page.request.post('http://127.0.0.1:8080/api/v1/users', {
      headers,
      data: { username, name, role: 'employee', branch_id: branch.id, password },
    });
    expect(r.ok()).toBeTruthy();
    if (username === first) firstId = (await r.json()).id;
  }
  const due = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mazatlan',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  expect(
    (
      await page.request.post('http://127.0.0.1:8080/api/v1/tasks', {
        headers,
        data: { branch_id: branch.id, user_id: firstId, title: 'Limpiar mostrador', due_date: due },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto('/');
  await signIn(page, 'cesar');
  await page.getByLabel('Sucursal').selectOption(branch.id);
  await nav(page, 'Configuración');
  await page.getByLabel('Nombre del equipo', {exact:true}).fill('Computadora piloto');
  await page.getByLabel('Caja de proveedores', { exact: true }).last().fill('2');
  await page.getByRole('button', { name: 'Registrar este equipo' }).click();
  await expect(
    page.getByText('La sucursal ya tiene equipo designado.', { exact: false }),
  ).toBeVisible();
  await nav(page, 'Caja general');
  await page.getByLabel('Efectivo total · MXN').fill('10000');
  await page.getByLabel('Parte en caja proveedores · MXN').fill('2000');
  await page.getByLabel('Saldo bancario · MXN').fill('5000');
  await page.getByRole('button', { name: 'Registrar apertura' }).click();
  await expect(page.getByRole('heading', { name: 'Nuevo movimiento' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await signIn(page, second);
  await expect(page.getByText('Acceso preparado hasta', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await signIn(page, first);
  await nav(page, 'Proveedores');
  await page.getByLabel('Empresa', { exact: true }).fill('Proveedor piloto');
  await page.getByRole('button', { name: 'Agregar proveedor' }).click();
  await expect(page.getByRole('cell', { name: 'Proveedor piloto' })).toBeVisible();
  await page.getByRole('button', { name: 'Sincronizar y actualizar' }).click();
  await expect(page.locator('.pending-panel')).toHaveCount(0);
  // Wait until the production PWA controls the page before cutting the network.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  });
  await context.setOffline(true);
  await nav(page, 'Caja proveedores');
  await page.getByRole('button', { name: 'Abrir mi turno' }).click();
  await expect(page.getByRole('heading', { name: 'Cerrar y entregar turno' })).toBeVisible();
  await page.getByLabel('Importe · MXN', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await nav(page, 'Proveedores');
  await page.getByLabel('Proveedor', { exact: true }).selectOption({ label: 'Proveedor piloto' });
  await page.getByLabel('Importe · MXN', { exact: true }).fill('300');
  await page.getByRole('button', { name: 'Guardar ticket' }).click();
  await expect(page.getByRole('cell', { name: '$300.00' })).toBeVisible();
  await nav(page, 'Tareas');
  const photo = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#059669' } })
    .png()
    .toBuffer();
  await page
    .getByLabel('Fotografía opcional · máximo 5 MiB')
    .setInputFiles({ name: 'evidencia.png', mimeType: 'image/png', buffer: photo });
  await page.getByLabel('Nota de finalización').fill('Evidencia guardada offline');
  await page.getByRole('button', { name: 'Completar tarea' }).click();
  await expect(page.getByText('Completada', { exact: true })).toBeVisible();
  // Browser reload offline: interface, encrypted access and local projection must survive.
  await page.reload();
  await signIn(page, first);
  await nav(page, 'Caja proveedores');
  await expect(page.locator('.stat').first()).toContainText('$2,200.00');
  await page.getByLabel('Efectivo contado · MXN').fill('2190');
  await page.getByRole('button', { name: 'Confirmar conteo y cierre' }).click();
  await expect(page.getByRole('button', { name: 'Abrir mi turno' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await signIn(page, second);
  await nav(page, 'Caja proveedores');
  await page.getByRole('button', { name: 'Abrir mi turno' }).click();
  await expect(page.locator('.stat').first()).toContainText('$2,190.00');
  const other = await context.newPage();
  await other.goto('/');
  await other.getByLabel('Usuario', { exact: true }).fill(first);
  await other.getByLabel('Contraseña', { exact: true }).fill(password);
  await other.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('Otra pestaña');
  await other.close();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Sincronizar y actualizar' }).click();
  await expect(page.locator('.pending-panel')).toHaveCount(0, { timeout: 20000 });
  const state = await page.request.get(
    `http://127.0.0.1:8080/api/v1/snapshot?branch_id=${branch.id}`,
    { headers },
  );
  const data = await state.json();
  expect(data.tickets).toHaveLength(1);
  expect(data.branch.balance_cents).toBe('219000');
  expect(data.treasury.reduce((n: number, t: any) => n + Number(t.cash_cents), 0)).toBe(970000);
  expect(data.tasks[0].completed_at).toBeTruthy();
  expect(data.tasks[0].media_id).toBeTruthy();
  // The eight-hour deadline is per employee and never extends after offline relogin.
  await context.setOffline(true);
  const real = Date.now();
  await page.clock.install({ time: new Date(real - 3600_000) });
  await page.getByLabel('Importe · MXN', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('reloj retrocedió');
  await page.clock.setSystemTime(new Date(real));
  await nav(page, 'Faltantes');
  await page.getByLabel('Producto', { exact: true }).fill('Agua pendiente');
  await page.getByRole('button', { name: 'Registrar faltante' }).click();
  await expect(page.locator('.pending-panel')).toBeVisible();
  await nav(page, 'Caja proveedores');
  await page.clock.setSystemTime(new Date(real + 9 * 3600_000));
  await page.getByLabel('Importe · MXN', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('venció');
  await expect(page.locator('.pending-panel')).toContainText('1 operación');
  await page.screenshot({ path: 'test-results/caja-proveedores.png', fullPage: true });
});
