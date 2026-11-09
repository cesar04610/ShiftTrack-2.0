import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const api = process.env.E2E_API_URL || 'http://127.0.0.1:8080',
  password = 'ShiftTrack-demo-2026!';
// Administrators go straight to their panel; signing in also records their entry.
async function login(page: Page, username: string) {
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión', exact: true })).toBeVisible();
}
// Administrators pick a register from the top bar only when they work at one.
async function select(page: Page, number: string) {
  const register = page.getByLabel('Caja de trabajo', { exact: true });
  await register.selectOption(number);
  await expect(register).toHaveValue(number);
  await expect(register).toBeEnabled();
}
// The board and "Mi horario" work on the current week, in the branch's time zone.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chihuahua' }).format(
  new Date(),
);
const weekStart = (() => {
  const noon = new Date(`${today}T12:00:00Z`);
  noon.setUTCDate(noon.getUTCDate() - ((noon.getUTCDay() + 6) % 7));
  return noon.toISOString().slice(0, 10);
})();
const day = (offset: number) =>
  new Date(Date.parse(`${weekStart}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
test('Mostrador: administrador organiza turnos y trabaja en caja; súper administrador conserva gestión y operación', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
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
  await expect(
    page.getByRole('button', { name: 'Menú de administrador', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alertas', exact: true })).toHaveCount(0);
  // Without a register the administrator only sees management; the work menu comes with a register.
  const workMenu = ['Horario', 'Tareas', 'Faltantes', 'Mi corte', 'Caja proveedores'];
  for (const name of workMenu)
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Horarios', exact: true }).click();
  const board = page.getByRole('region', { name: 'Pizarra semanal de horarios' });
  await expect(board).toBeVisible();
  // The board opens on the current week, the one this test plans.
  await expect(board.getByLabel('Semana del')).toHaveValue(weekStart);
  await expect(page.getByLabel('Empleado', { exact: true }).first()).toContainText(
    'Gerente pizarra',
  );
  await expect(page.getByLabel('Empleado', { exact: true }).first()).toContainText(owner.user.name);
  const monday = board.locator(`.board-slot[data-date="${day(0)}"][data-shift="morning"]`);
  await board
    .getByRole('button', { name: `Seleccionar a ${employeeName}`, exact: true })
    .dragTo(monday);
  const chip = monday.getByRole('button', {
    name: `Editar turno de ${employeeName} lunes Mañana`,
    exact: true,
  });
  await expect(chip).toContainText('07:30–15:00');
  const personColor = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(chip).toHaveAttribute('title', new RegExp(employeeName));
  await chip.click();
  let dialog = page.getByRole('dialog', { name: `Turno de ${employeeName}` });
  await dialog.getByRole('button', { name: /Medio turno/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(chip).toContainText('12:00–15:00');
  const tuesday = board.locator(`.board-slot[data-date="${day(1)}"][data-shift="afternoon"]`);
  await chip.dragTo(tuesday);
  await expect(monday.locator('.assigned')).toHaveCount(0);
  const moved = tuesday.locator('.assigned');
  await expect(moved).toContainText('18:30–21:30');
  expect(await moved.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(personColor);
  await moved.click();
  dialog = page.getByRole('dialog', { name: `Turno de ${employeeName}` });
  await dialog.getByRole('button', { name: /Turno completo/ }).click();
  await expect(moved).toContainText('15:00–21:30');
  await board.getByRole('button', { name: 'Seleccionar a Gerente pizarra', exact: true }).click();
  await board.getByRole('button', { name: 'Asignar a miércoles Mañana', exact: true }).click();
  await expect(
    board.locator(`.board-slot[data-date="${day(2)}"][data-shift="morning"] .assigned`),
  ).toContainText('Gerente');
  await board
    .getByRole('button', { name: `Seleccionar a ${owner.user.name}`, exact: true })
    .click();
  await board.getByRole('button', { name: 'Asignar a viernes Mañana', exact: true }).click();
  await expect(
    board.locator(`.board-slot[data-date="${day(4)}"][data-shift="morning"] .assigned`),
  ).toContainText(owner.user.name.split(' ')[0]);
  // Exercise a full weekly board, with enough staff to expose scroll and sizing problems.
  for (const [index, name] of [
    'Jenny López',
    'Lupe Ramírez',
    'Orlando Pérez',
    'Ximena García',
    'Thanya Ruiz',
    'Guillermo Soto',
  ].entries()) {
    const person = await page.request.post(`${api}/api/v1/users`, {
      headers,
      data: {
        branch_id: branch.id,
        username: `compact-${index}-${suffix}`,
        name,
        role: 'employee',
        password,
      },
    });
    expect(person.ok()).toBeTruthy();
    const id = (await person.json()).id;
    for (let offset = 0; offset < 7; offset++) {
      const scheduled = await page.request.post(`${api}/api/v1/schedules/board`, {
        headers,
        data: {
          branch_id: branch.id,
          user_id: id,
          business_date: day(offset),
          shift: index < 4 ? 'morning' : 'afternoon',
          half: index === 5,
        },
      });
      expect(scheduled.ok()).toBeTruthy();
    }
  }
  await page.getByRole('button', { name: 'Sincronizar y actualizar', exact: true }).click();
  await expect(
    board.getByRole('button', { name: 'Seleccionar a Jenny López', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  // Two-line chips (name and hours) make a full week taller than a laptop screen; the page scrolls
  // down, but the week never scrolls sideways and no chip is clipped.
  let bounds = await board.boundingBox();
  expect(
    await board.locator('.board-days').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  expect(
    await board
      .locator('.board-assigned')
      .evaluateAll((elements) => elements.every((el) => el.scrollHeight <= el.clientHeight + 1)),
  ).toBeTruthy();
  expect(
    await board
      .locator('.personnel-chips')
      .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBeTruthy();
  await board.getByRole('button', { name: 'Ampliar pizarra', exact: true }).click();
  // Expanded, the board takes the whole window.
  const expanded = (await board.boundingBox())!;
  expect(expanded.y).toBeLessThanOrEqual(16);
  expect(expanded.height).toBeGreaterThanOrEqual(768 - 32);
  await page.keyboard.press('Escape');
  await expect(board.getByRole('button', { name: 'Ampliar pizarra', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  bounds = await board.boundingBox();
  expect(
    await board.locator('.board-days').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  // On a phone the people list is a short box that scrolls; everyone stays reachable.
  const last = board.getByRole('button', { name: 'Seleccionar a Guillermo Soto', exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await board.getByRole('button', { name: 'Ampliar pizarra', exact: true }).click();
  expect(
    await board
      .locator('.board-assigned')
      .evaluateAll((elements) => elements.every((el) => el.scrollHeight <= el.clientHeight + 1)),
  ).toBeTruthy();
  await board.screenshot({ path: '/tmp/mostrador-pizarra-movil.png' });
  await board.getByRole('button', { name: 'Reducir pizarra', exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 768 });
  await board.screenshot({ path: '/tmp/mostrador-pizarra.png' });
  await select(page, '3');
  for (const name of workMenu)
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
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
  // The supplier field is a search box: type part of the name and pick the result.
  await page.getByLabel('Proveedor', { exact: true }).fill('gerente');
  await page.getByRole('option', { name: 'Proveedor gerente', exact: true }).click();
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
  expect(snapshot.schedules).toHaveLength(45);
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await login(page, 'cesar');
  await page.getByLabel('Sucursal', { exact: true }).selectOption(branch.id);
  await select(page, '1');
  await expect(
    page.getByRole('button', { name: 'Menú de súper administrador', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alertas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Horario', exact: true }).click();
  // "Mi horario" shows the owner's Friday shift as "Viernes <day>".
  await expect(
    page.getByRole('cell', { name: `Viernes ${Number(day(4).slice(8))}`, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Caja proveedores', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardar ticket', exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      'Para registrar pagos y tickets, selecciona la caja de proveedores de esta sucursal.',
      { exact: true },
    ),
  ).toBeVisible();
});
