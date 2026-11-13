import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { sicarFile, sicarRow } from '../xls-fixture';
const password = 'ShiftTrack-demo-2026!';
const api = process.env.E2E_API_URL || 'http://127.0.0.1:8080';
test('ventas de respaldo: catálogo de SICAR, venta con teclado, cobro, venta sin Internet y corte', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 8),
    username = `caja-${suffix}`;
  const login = await page.request.post(`${api}/api/v1/auth/login`, {
    data: { username: 'cesar', password },
  });
  const headers = { Authorization: `Bearer ${(await login.json()).access_token}` };
  const created = await page.request.post(`${api}/api/v1/branches`, {
    headers,
    data: { name: `Ventas ${suffix}`, register_count: 2, supplier_register: 2 },
  });
  expect(created.ok()).toBeTruthy();
  const branch = await created.json();
  expect(
    (
      await page.request.post(`${api}/api/v1/users`, {
        headers,
        data: { username, name: 'Caja prueba', role: 'employee', branch_id: branch.id, password },
      })
    ).ok(),
  ).toBeTruthy();

  // The owner imports the SICAR export from the Productos page.
  await page.goto('/');
  await page.getByLabel('Usuario', { exact: true }).fill('cesar');
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByLabel('Sucursal', { exact: true }).selectOption(branch.id);
  await page.getByRole('button', { name: 'Productos', exact: true }).click();
  await expect(page.getByText('Todavía no se ha importado el catálogo')).toBeVisible();
  await page.getByRole('button', { name: 'Importar catálogo de SICAR' }).click();
  const dialog = page.getByRole('dialog', { name: 'Importar catálogo de SICAR' });
  await dialog.getByLabel('Archivo de SICAR', { exact: false }).setInputFiles({
    name: 'articulosExportados.xls',
    mimeType: 'application/vnd.ms-excel',
    buffer: sicarFile([
      sicarRow('7501055302925', '', 'Coca cola pet 2L', '43.000000'),
      sicarRow('dt', '608890030475', 'Tamix Picositas', '3.703700', { ieps: true }),
      sicarRow('1000', '', 'Aguacate kg', '58.000000', { bulk: true }),
      sicarRow('500', '', 'Bolsa sin precio', '0.000000'),
      sicarRow('', '', 'Fila sin clave', '1.000000'),
    ]),
  });
  await dialog.getByRole('button', { name: 'Revisar archivo' }).click();
  await expect(dialog).toContainText('4 productos en el archivo: 4 nuevos');
  await expect(dialog).toContainText('1 no tienen precio');
  await expect(dialog).toContainText('1 filas tienen errores y se omitirán');
  await dialog.getByRole('button', { name: 'Guardar catálogo de 4 productos' }).click();
  await expect(dialog.getByText('Catálogo guardado correctamente.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(page.getByText('4 productos a la venta')).toBeVisible();
  await page.getByLabel('Consultar un producto del catálogo').fill('tamix');
  await expect(page.getByRole('cell', { name: '$4.00', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  // The cashier sells with the keyboard, as in SICAR.
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await page.getByRole('button', { name: 'Ventas', exact: true }).click();
  const total = page.locator('.pos-total strong'),
    lines = page.locator('.pos-lines tbody tr');
  const scan = async (code: string) => {
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
  };
  await expect(page.getByLabel('Código del producto')).toBeFocused();
  await scan('7501055302925');
  await scan('7501055302925');
  await scan('608890030475');
  await scan('1000');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toContainText('2');
  await expect(total).toHaveText('$148.00');
  await scan('no-existe');
  await expect(page.getByRole('alert')).toHaveText('Producto no encontrado: no-existe');
  await scan('500');
  await expect(page.getByRole('alert')).toContainText('no tiene precio en el catálogo');
  await expect(lines).toHaveCount(3);
  // F5 weighs the last product: 750 grams of a bulk product.
  await page.keyboard.press('F5');
  await expect(page.getByRole('dialog', { name: 'Aguacate kg' })).toBeVisible();
  await page.keyboard.type('750');
  await page.keyboard.press('Enter');
  await expect(lines.nth(2)).toContainText('0.750 kg');
  await expect(total).toHaveText('$133.50');
  // F6 deletes the selected product; with none selected it asks before deleting everything.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('F6');
  await expect(lines).toHaveCount(2);
  await expect(total).toHaveText('$129.50');
  await page.keyboard.press('F6');
  await expect(
    page.getByRole('dialog', { name: '¿Deseas borrar todos los productos?' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lines).toHaveCount(2);
  // Clicking the quantity changes it too.
  await lines
    .nth(0)
    .getByRole('button', { name: /Cantidad de Coca cola/ })
    .click();
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await expect(total).toHaveText('$172.50');
  // Esc charges: cash by default, the change is shown before and after finishing.
  await page.keyboard.press('Escape');
  const pay = page.getByRole('dialog', { name: 'Cobrar' });
  await expect(pay.getByRole('radio', { name: /Efectivo/ })).toBeChecked();
  await page.keyboard.type('100');
  await page.keyboard.press('Enter');
  await expect(pay.getByRole('alert')).toHaveText('Faltan $72.50 para cubrir el total.');
  await pay.getByLabel('Paga con · MXN').fill('200');
  await expect(pay.locator('.pos-amount.change strong')).toHaveText('$27.50');
  await page.keyboard.press('Enter');
  const done = page.getByRole('dialog', { name: 'Venta registrada' });
  await expect(done).toContainText('Cambio entregado');
  await expect(done.locator('strong')).toHaveText('$27.50');
  // The change screen only closes with Esc; a scan meanwhile must not start a sale.
  await scan('7501055302925');
  await expect(done).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(done).toBeHidden();
  await expect(lines).toHaveCount(0);
  await expect(total).toHaveText('$0.00');

  // Without Internet the catalog and the sale stay on this computer.
  await context.setOffline(true);
  await expect(page.getByText('Sin conexión', { exact: true })).toBeVisible();
  await page.keyboard.press('F2');
  const search = page.getByRole('dialog', { name: 'Buscar producto' });
  await page.keyboard.type('picositas');
  await expect(search.locator('tbody tr')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(search).toBeHidden();
  await expect(total).toHaveText('$4.00');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F9');
  await expect(pay.getByRole('radio', { name: /Tarjeta/ })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(done).toContainText('Pago con tarjeta');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F10');
  const turn = page.getByRole('dialog', { name: 'Ventas del turno' });
  await expect(turn.locator('.turn-sales strong')).toHaveText(['$176.50', '$172.50', '$4.00']);
  await expect(turn).toContainText('2 ventas');

  // Back online the pending sale reaches the server exactly once.
  await context.setOffline(false);
  await turn.getByRole('button', { name: 'Ir a Mi corte' }).click();
  await expect(page.getByRole('heading', { name: 'Mi corte', level: 1 })).toBeVisible();
  await expect(page.locator('.turn-sales strong').first()).toHaveText('$176.50');
  await page.getByRole('button', { name: 'Sincronizar y actualizar' }).click();
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await expect
    .poll(async () => {
      const dates = [today, new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10)];
      let found: any[] = [];
      for (const date of dates)
        found = found.concat(
          (
            await (
              await page.request.get(`${api}/api/v1/sales?branch_id=${branch.id}&date=${date}`, {
                headers,
              })
            ).json()
          ).sales,
        );
      return found.map((s) => `${s.payment}:${s.total_cents}:${s.items.length}`).sort();
    })
    .toEqual(['card:400:1', 'cash:17250:2']);
  await page.getByRole('button', { name: 'Sincronizar y actualizar' }).click();
  await expect(page.locator('.turn-sales strong').first()).toHaveText('$176.50');
});
