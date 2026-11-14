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
async function supplierBox(page: Page) {
  await page.getByLabel('Selecciona tu caja', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Entrar a esta caja', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Horario', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Caja proveedores', exact: true }).click();
}
test('una captura de proveedores rechazada bloquea la caja hasta que un administrador la descarta', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8),
    username = `revision-${suffix}`;
  const owner = await page.request.post(`${apiBase}/api/v1/auth/login`, {
    data: { username: 'cesar', password },
  });
  const headers = { Authorization: `Bearer ${(await owner.json()).access_token}` };
  const created = await page.request.post(`${apiBase}/api/v1/branches`, {
    headers,
    data: { name: `Revisión ${suffix}`, register_count: 2, supplier_register: 1 },
  });
  const branch = (await created.json()).id;
  expect(
    (
      await page.request.post(`${apiBase}/api/v1/users`, {
        headers,
        data: { branch_id: branch, username, name: 'Cajera revisión', role: 'employee', password },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post(`${apiBase}/api/v1/treasury/opening`, {
        headers,
        data: { branch_id: branch, cash_cents: '100000', bank_cents: '0', supplier_cents: '50000' },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto('/');
  await signIn(page, username);
  await supplierBox(page);
  // A close the server rejected, as it stays on the device after a sync (see "La versión de caja cambió").
  await page.evaluate(
    ({ branchId }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('shifttrack-v1');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('outbox', 'readwrite');
          tx.objectStore('outbox').put({
            id: 'rechazada-1',
            command: {
              operation_id: 'rechazada-1',
              type: 'supplier.shift.close',
              branch_id: branchId,
              occurred_at: '2026-11-13T03:45:35.632Z',
              payload: { counted_cents: '288300' },
            },
            state: 'needs_review',
            message: 'La versión de caja cambió. Requiere revisión.',
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    { branchId: branch },
  );
  await page.getByRole('button', { name: 'Sincronizar y actualizar' }).click();
  const panel = page.locator('.pending-panel');
  await expect(panel).toContainText('Hay operaciones que requieren revisión');
  await panel.locator('summary').click();
  await expect(panel).toContainText('Cierre caja proveedores');
  await expect(panel).toContainText('La versión de caja cambió');
  // An employee cannot discard it, and the box stays stopped with a clear explanation.
  await expect(panel.getByRole('button', { name: 'Descartar', exact: true })).toHaveCount(0);
  await expect(panel).toContainText('Un administrador puede revisarla');
  await page.getByRole('button', { name: 'Abrir mi turno', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Un administrador debe revisarla');
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  // The administrator signs in on the same device and discards it after confirming.
  await signIn(page, 'cesar');
  await page.getByLabel('Sucursal', { exact: true }).selectOption(branch);
  await page.locator('.pending-panel summary').click();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('Cierre caja proveedores');
    void dialog.accept();
  });
  const backup = page.waitForEvent('download');
  await page
    .locator('.pending-panel')
    .getByRole('button', { name: 'Descartar', exact: true })
    .click();
  expect((await backup).suggestedFilename()).toBe('mostrador-descartada-rechazada-1.json');
  await expect(page.locator('.pending-panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  // The employee can operate the supplier box again.
  await signIn(page, username);
  await supplierBox(page);
  await page.getByRole('button', { name: 'Abrir mi turno', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cerrar y entregar turno', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.pending-panel')).toHaveCount(0, { timeout: 20000 });
});
