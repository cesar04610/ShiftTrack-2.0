import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
const password = 'ShiftTrack-demo-2026!';
const apiBase = process.env.E2E_API_URL || 'http://127.0.0.1:8080';
async function signIn(page: Page, username: string) {
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
  if (username !== 'cesar') {
    await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('2');
    await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Horario', exact: true, level: 1 }),
    ).toBeVisible();
  }
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
  const response = await page.request.post(`${apiBase}/api/v1/auth/login`, {
    data: { username: 'cesar', password },
  });
  const initial = await response.json();
  expect(response.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${initial.access_token}` };
  const created = await page.request.post(`${apiBase}/api/v1/branches`, {
    headers,
    data: { name: branchName, register_count: 3, supplier_register: 2 },
  });
  expect(created.ok()).toBeTruthy();
  const branch = await created.json();
  let firstId = '';
  for (const [username, name] of [
    [first, 'Ana prueba'],
    [second, 'Luis prueba'],
  ]) {
    const r = await page.request.post(`${apiBase}/api/v1/users`, {
      headers,
      data: { username, name, role: 'employee', branch_id: branch.id, password },
    });
    expect(r.ok()).toBeTruthy();
    if (username === first) firstId = (await r.json()).id;
  }
  await page.goto('/');
  await signIn(page, 'cesar');
  // The owner goes straight to the panel; no register is needed to manage the branch.
  await page.getByLabel('Sucursal').selectOption(branch.id);
  // Tasks are written once per register and shift; whoever enters that register receives them.
  await nav(page, 'Gestionar tareas');
  await page.getByRole('button', { name: /^Caja 2/ }).click();
  // The lists open on today's weekday; another day has its own, empty lists.
  const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const today = (
    await page.locator('.task-weekdays button[aria-pressed="true"]').innerText()
  ).split(/\s/)[0];
  expect(weekdays).toContain(today);
  const taskList = (name: string) =>
    page.locator('.task-list').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const morning = taskList('Turno mañana'),
    afternoon = taskList('Turno tarde');
  for (const title of ['Limpiar mostrador', 'Acomodar refrescos']) {
    await morning.getByLabel('Nueva tarea para Turno mañana').fill(title);
    await morning.getByRole('button', { name: 'Agregar', exact: true }).click();
    await expect(morning.getByText(title, { exact: true })).toBeVisible();
  }
  await morning.getByRole('button', { name: 'Editar Acomodar refrescos' }).click();
  await morning.getByLabel('Tarea', { exact: true }).fill('Acomodar bebidas');
  await morning.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(morning.getByText('Acomodar bebidas', { exact: true })).toBeVisible();
  await morning.getByRole('button', { name: 'Quitar Acomodar bebidas' }).click();
  await morning.getByRole('button', { name: 'Quitar', exact: true }).click();
  await expect(morning.getByText('Acomodar bebidas', { exact: true })).toHaveCount(0);
  // The afternoon copies the morning list, so the employee gets one task at any hour.
  await afternoon
    .getByLabel('Copiar tareas a Turno tarde')
    .selectOption({ label: `${today} · Caja 2 · Turno mañana` });
  await expect(afternoon.getByText('Limpiar mostrador', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Caja 2/ })).toContainText('2');
  const tomorrow = weekdays[(weekdays.indexOf(today) + 1) % 7];
  await page.getByRole('button', { name: new RegExp(`^${tomorrow}`) }).click();
  await expect(page.getByText('Limpiar mostrador', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Sin tareas todavía.')).toHaveCount(4);
  // An extraordinary task goes to one person and can be removed while pending.
  await page.getByRole('button', { name: 'Tarea extra', exact: true }).click();
  await page.getByLabel('Persona', { exact: true }).selectOption({ label: 'Ana prueba' });
  await page.getByLabel('Tarea', { exact: true }).fill('Recibir pedido especial');
  await page.getByRole('button', { name: 'Asignar tarea', exact: true }).click();
  const person = page.locator('.task-person');
  await expect(person.getByRole('heading', { name: 'Ana prueba' })).toBeVisible();
  await expect(person.getByText('Tarea extra', { exact: true })).toBeVisible();
  await person.getByRole('button', { name: 'Quitar Recibir pedido especial' }).click();
  await expect(person).toHaveCount(0);
  await nav(page, 'Configuración');
  await nav(page, 'Caja general');
  await page.getByLabel('Efectivo total · MXN').fill('10000');
  await page.getByLabel('Parte en caja proveedores · MXN').fill('2000');
  await page.getByLabel('Saldo bancario · MXN').fill('5000');
  await page.getByRole('button', { name: 'Registrar apertura' }).click();
  await expect(page.getByRole('heading', { name: 'Nuevo movimiento' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await signIn(page, second);
  await expect(page.getByText('Acceso offline preparado', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await signIn(page, first);
  await nav(page, 'Caja proveedores');
  await page.getByRole('button', { name: 'Agregar proveedores', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Agregar proveedor' });
  await expect(dialog.getByLabel('Representante / teléfono', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('Empresa', { exact: true }).fill('Proveedor piloto');
  await dialog.getByLabel('Representante', { exact: true }).fill('María');
  await dialog.getByLabel('Teléfono', { exact: true }).fill('6691234567');
  await dialog.getByLabel('Tipo de producto', { exact: true }).fill('Bebidas');
  await dialog.getByRole('button', { name: 'Agregar proveedor', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // The supplier field is a search box: the new supplier appears among the results.
  await page.getByLabel('Proveedor', { exact: true }).fill('piloto');
  await expect(page.getByRole('option', { name: /^Proveedor piloto/ })).toHaveCount(1);
  await page.getByLabel('Proveedor', { exact: true }).fill('');
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
  // Wait until the app noticed the lost connection before capturing.
  await expect(page.getByText('Sin conexión', { exact: true })).toBeVisible();
  await nav(page, 'Caja proveedores');
  await page.getByRole('button', { name: 'Abrir mi turno' }).click();
  await expect(page.getByRole('heading', { name: 'Cerrar y entregar turno' })).toBeVisible();
  await page
    .locator('.card')
    .filter({
      has: page.getByRole('heading', { name: 'Agregar efectivo a proveedores', exact: true }),
    })
    .getByLabel('Importe · MXN', { exact: true })
    .fill('500');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await nav(page, 'Caja proveedores');
  await page.getByLabel('Proveedor', { exact: true }).fill('piloto');
  await page.getByRole('option', { name: /^Proveedor piloto/ }).click();
  await page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: 'Registrar pago', exact: true }) })
    .getByLabel('Importe · MXN', { exact: true })
    .fill('300');
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
  const state = await page.request.get(`${apiBase}/api/v1/snapshot?branch_id=${branch.id}`, {
    headers,
  });
  const data = await state.json();
  expect(data.tickets).toHaveLength(1);
  expect(data.suppliers[0]).toMatchObject({
    representative: 'María',
    phone: '6691234567',
    product_type: 'Bebidas',
  });
  expect(data.branch.balance_cents).toBe('219000');
  // The general cash balance comes from the server's totals over every movement.
  expect(data.treasury_totals.cash_cents).toBe('970000');
  // Both employees entered register 2, so each received the list; only the first one did it.
  expect(data.tasks.map((t: any) => t.title)).toEqual(['Limpiar mostrador', 'Limpiar mostrador']);
  const done = data.tasks.find((t: any) => t.user_id === firstId);
  expect(done).toMatchObject({ register_number: 2, half: false });
  expect(done.completed_at).toBeTruthy();
  expect(done.media_id).toBeTruthy();
  // Clock rollback still blocks capture, but nine hours do not expire the prepared access.
  await context.setOffline(true);
  // Wait until the app noticed the lost connection before capturing.
  await expect(page.getByText('Sin conexión', { exact: true })).toBeVisible();
  const real = Date.now();
  await page.clock.install({ time: new Date(real - 3600_000) });
  await page
    .locator('.card')
    .filter({
      has: page.getByRole('heading', { name: 'Agregar efectivo a proveedores', exact: true }),
    })
    .getByLabel('Importe · MXN', { exact: true })
    .fill('1');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('reloj retrocedió');
  await page.clock.setSystemTime(new Date(real));
  await nav(page, 'Faltantes');
  await page.getByLabel('Producto', { exact: true }).fill('Agua pendiente');
  await page.getByRole('button', { name: 'Registrar faltante' }).click();
  await expect(page.locator('.pending-panel')).toBeVisible();
  // Nine hours later the prepared access still signs captures. A shortage is used because the
  // supplier box would ask to reconcile once the calendar day changes, depending on the hour.
  await page.clock.setSystemTime(new Date(real + 9 * 3600_000));
  await page.getByLabel('Producto', { exact: true }).fill('Agua nueve horas después');
  await page.getByRole('button', { name: 'Registrar faltante' }).click();
  await expect(page.getByRole('status')).toContainText('Registro guardado correctamente');
  await expect(page.locator('.pending-panel')).toContainText('2 registro(s)');
  await page.screenshot({ path: 'test-results/caja-proveedores.png', fullPage: true });
});
