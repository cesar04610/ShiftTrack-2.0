import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const api = process.env.E2E_API_URL || 'http://127.0.0.1:8080',
  password = 'ShiftTrack-demo-2026!';
async function login(page: Page, username: string) {
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Selecciona la caja en la que estás', exact: true }),
  ).toBeVisible();
}
async function select(page: Page, number: string) {
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption(number);
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(page.getByLabel('Selecciona tu caja', { exact: true })).toHaveCount(0);
}
test('Mostrador: administrador organiza turnos y trabaja en caja; súper administrador conserva gestión y operación', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const auth = await page.request.post(`${api}/api/v1/auth/login`, {
    data: { username: 'cesar', password },
  });
  expect(auth.ok()).toBeTruthy();
  const owner = await auth.json(),
    headers = { Authorization: `Bearer ${owner.access_token}` };
  const suffix = randomUUID().slice(0, 8),
    branchName = `Pizarra ${suffix}`,
    manager = `gerente-${suffix}`,
    employeeName = `Equipo ${suffix}`;
  const created = await page.request.post(`${api}/api/v1/branches`, {
    headers,
    data: { name: branchName, register_count: 3, supplier_register: 3 },
  });
  expect(created.ok()).toBeTruthy();
  const branch = await created.json();
  for (const [username, name, role] of [
    [manager, 'Gerente pizarra', 'admin'],
    [`empleado-${suffix}`, employeeName, 'employee'],
  ]) {
    const r = await page.request.post(`${api}/api/v1/users`, {
      headers,
      data: { branch_id: branch.id, username, name, role, password },
    });
    expect(r.ok()).toBeTruthy();
  }
  const opening = await page.request.post(`${api}/api/v1/treasury/opening`, {
    headers,
    data: { branch_id: branch.id, cash_cents: '100000', bank_cents: '0', supplier_cents: '20000' },
  });
  expect(opening.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page).toHaveTitle('Mostrador 2.0');
  await login(page, manager);
  await page.getByRole('button', { name: 'Continuar sin caja', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Menú de administrador', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alertas', exact: true })).toHaveCount(0);
  for (const name of [
    'Horario',
    'Registro de entradas',
    'Tareas',
    'Faltantes',
    'Mi corte',
    'Caja proveedores',
  ])
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Horarios', exact: true }).click();
  const board = page.getByRole('region', { name: 'Pizarra semanal de horarios' });
  await expect(board).toBeVisible();
  await board.getByLabel('Semana del').fill('2026-11-02');
  await expect(page.getByLabel('Empleado', { exact: true }).first()).toContainText(
    'Gerente pizarra',
  );
  await expect(page.getByLabel('Empleado', { exact: true }).first()).toContainText(owner.user.name);
  const monday = board.locator('.board-slot[data-date="2026-11-02"][data-shift="morning"]');
  await board
    .getByRole('button', { name: `Seleccionar a ${employeeName}`, exact: true })
    .dragTo(monday);
  const chip = monday.getByRole('button', {
    name: `Editar turno de ${employeeName} lunes Mañana`,
    exact: true,
  });
  await expect(chip).toContainText('07:30 – 15:00');
  await chip.click();
  let dialog = page.getByRole('dialog', { name: `Turno de ${employeeName}` });
  await dialog.getByRole('button', { name: /Medio turno/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(chip).toContainText('12:00 – 15:00');
  const tuesday = board.locator('.board-slot[data-date="2026-11-03"][data-shift="afternoon"]');
  await chip.dragTo(tuesday);
  await expect(monday.locator('.assigned')).toHaveCount(0);
  const moved = tuesday.locator('.assigned');
  await expect(moved).toContainText('18:30 – 21:30');
  await moved.click();
  dialog = page.getByRole('dialog', { name: `Turno de ${employeeName}` });
  await dialog.getByRole('button', { name: /Turno completo/ }).click();
  await expect(moved).toContainText('15:00 – 21:30');
  await board.getByRole('button', { name: 'Seleccionar a Gerente pizarra', exact: true }).click();
  await board.getByRole('button', { name: 'Asignar a miércoles Mañana', exact: true }).click();
  await expect(
    board.locator('.board-slot[data-date="2026-11-04"][data-shift="morning"] .assigned'),
  ).toContainText('Gerente pizarra');
  await board
    .getByRole('button', { name: `Seleccionar a ${owner.user.name}`, exact: true })
    .click();
  await board.getByRole('button', { name: 'Asignar a viernes Mañana', exact: true }).click();
  await expect(
    board.locator('.board-slot[data-date="2026-11-06"][data-shift="morning"] .assigned'),
  ).toContainText(owner.user.name);
  await board.screenshot({ path: '/tmp/mostrador-pizarra.png' });
  await page.getByRole('button', { name: 'Seleccionar caja', exact: true }).click();
  await select(page, '3');
  await page.getByRole('button', { name: 'Registro de entradas', exact: true }).click();
  await page.getByRole('button', { name: 'Registrar entrada', exact: true }).click();
  await page.getByRole('button', { name: 'Mi corte', exact: true }).click();
  await page.getByLabel('Ventas totales · MXN').fill('100');
  await page.getByLabel('Pagos con tarjeta · MXN').fill('20');
  await page.getByLabel('Efectivo contado de ventas · MXN').fill('80');
  await page.getByRole('button', { name: 'Guardar corte', exact: true }).click();
  await expect(page.locator('.pending-panel')).toHaveCount(0, { timeout: 20000 });
  await page.getByRole('button', { name: 'Caja proveedores', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir mi turno', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cerrar y entregar turno', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Agregar proveedores', exact: true }).click();
  const supplierDialog = page.getByRole('dialog', { name: 'Agregar proveedor' });
  await supplierDialog.getByLabel('Empresa', { exact: true }).fill('Proveedor gerente');
  await supplierDialog.getByRole('button', { name: 'Agregar proveedor', exact: true }).click();
  await expect(supplierDialog).not.toBeVisible();
  await page.getByLabel('Proveedor', { exact: true }).selectOption({ label: 'Proveedor gerente' });
  const payment = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: 'Registrar pago', exact: true }) });
  await payment.getByLabel('Importe · MXN', { exact: true }).fill('50');
  await payment.getByRole('button', { name: 'Guardar ticket', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Proveedor gerente', exact: true })).toHaveCount(2);
  await expect(page.locator('.pending-panel')).toHaveCount(0, { timeout: 20000 });
  const shot = await page.request.get(`${api}/api/v1/snapshot?branch_id=${branch.id}`, { headers });
  const snapshot = await shot.json();
  expect(snapshot.cuts).toHaveLength(1);
  expect(snapshot.tickets).toHaveLength(1);
  expect(snapshot.schedules).toHaveLength(3);
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await login(page, 'cesar');
  await page.getByLabel('Sucursal', { exact: true }).selectOption(branch.id);
  await select(page, '1');
  await expect(
    page.getByRole('button', { name: 'Menú de súper administrador', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alertas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Horario', exact: true }).click();
  await expect(page.getByRole('cell', { name: '2026-11-06', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Caja proveedores', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardar ticket', exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      'Para registrar pagos y tickets, selecciona la caja de proveedores de esta sucursal.',
      { exact: true },
    ),
  ).toBeVisible();
});
