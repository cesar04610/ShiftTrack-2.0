import { test, before, after } from 'node:test';
import { strict as a } from 'node:assert';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  SHIFT_DURATION_SEC,
  SUPPLIER_SPOT,
  REGISTER_XS,
  COUNTER_Y,
  assignCashierTask,
  createInitialState,
  handleCanvasClick,
  stepGame,
} from '../apps/web/src/minigame-engine.js';

if (
  !process.env.MIGRATION_DATABASE_URL ||
  process.env.NODE_ENV === 'production' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(process.env.MIGRATION_DATABASE_URL).hostname,
  )
)
  throw Error('Las pruebas requieren PostgreSQL local.');

process.env.NODE_ENV = 'test';
const { app } = await import('../apps/api/src/server.js');
const { pool } = await import('../apps/api/src/db.js');
const { issueSession } = await import('../apps/api/src/security.js');

const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const branchA = randomUUID();
const branchB = randomUUID();
const userIds: string[] = [];

let server: ReturnType<typeof app.listen>;
let base: string;
let ownerToken: string;
let adminToken: string;
let emp1Token: string;
let emp2Token: string;
let otherBranchToken: string;
let ownerId: string;
let adminId: string;
let emp1Id: string;
let emp2Id: string;

async function api(path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  await db.connect();
  await db.query('INSERT INTO branches(id,name,register_count) VALUES($1,$2,3),($3,$4,2)', [
    branchA,
    'Sucursal Minijuego A',
    branchB,
    'Sucursal Minijuego B',
  ]);

  const makeUser = async (
    name: string,
    role: 'superadmin' | 'admin' | 'employee',
    branch: string | null,
  ) => {
    const id = randomUUID();
    userIds.push(id);
    const username = `mg_${id.slice(0, 8)}`;
    await db.query('INSERT INTO users(id,username,name,role,branch_id) VALUES($1,$2,$3,$4,$5)', [
      id,
      username,
      name,
      role,
      branch,
    ]);
    const session = await issueSession({
      id,
      username,
      name,
      role,
      branch_id: branch,
      active: true,
      auth_version: 1,
    });
    return { id, token: session.access_token };
  };

  const owner = await makeUser('César Dueño', 'superadmin', null);
  const admin = await makeUser('Laura Admin', 'admin', branchA);
  const emp1 = await makeUser('Ana Cajera', 'employee', branchA);
  const emp2 = await makeUser('Luis Cajero', 'employee', branchA);
  const other = await makeUser('Carlos Otra', 'employee', branchB);

  ownerId = owner.id;
  ownerToken = owner.token;
  adminId = admin.id;
  adminToken = admin.token;
  emp1Id = emp1.id;
  emp1Token = emp1.token;
  emp2Id = emp2.id;
  emp2Token = emp2.token;
  otherBranchToken = other.token;

  server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('No se pudo abrir servidor de prueba.');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server?.close();
  await db.query('DELETE FROM minigame_scores WHERE branch_id IN ($1,$2)', [branchA, branchB]);
  await db.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
  await db.query('DELETE FROM clock_records WHERE branch_id IN ($1,$2)', [branchA, branchB]);
  await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  await db.query('DELETE FROM branches WHERE id IN ($1,$2)', [branchA, branchB]);
  await db.end();
  await pool.end();
});

test('motor del minijuego: 3 cajeros atienden, rellenan, limpian y reciben proveedor', () => {
  const rng = () => 0.35;
  const state = createInitialState('shift', 'morning', 'playing');
  a.equal(state.cashiers.length, 3);
  a.deepEqual(
    state.cashiers.map((c) => c.specialty),
    ['checkout', 'restock', 'clean'],
  );

  // Drop stock & create a mess to test restocking and cleaning directly
  state.stock = 55;
  state.cleanliness = 60;
  state.messes.push({
    id: 999,
    x: 320,
    y: 230,
    kind: 'spill',
    color: '#f97316',
    progress: 0,
    size: 16,
  });

  // Assign Mateo (1) to restock and Valeria (2) to clean; Sofía (0) stays at Caja 1
  assignCashierTask(state, 1, 'restock');
  assignCashierTask(state, 2, 'clean');
  a.equal(state.cashiers[1].task, 'restock');
  a.equal(state.cashiers[2].task, 'clean');

  // Step 12 seconds so customers arrive, browse, queue, get served, shelves refill, mess gets cleaned
  for (let i = 0; i < 240; i++) stepGame(state, 0.05, rng);

  a.ok(state.stock > 70, `Esperaba surtido recuperado, obtuvo ${state.stock}`);
  a.ok(state.messesCleaned >= 1, 'Valeria debe limpiar al menos una mancha');
  a.ok(state.customersServed >= 1, 'Sofía debe atender al menos un cliente');
  a.ok(state.score > 0 && state.salesCents > 0, 'Debe acumular puntos y venta simulada');

  // Trigger supplier event and receive it via canvas click
  state.supplier = {
    active: true,
    timeLeft: 18,
    maxTime: 18,
    progress: 0,
    duration: 2.0,
    company: 'Refrescos del Norte',
  };
  state.stock = 40;
  state.selectedCashier = 1;
  const clicked = handleCanvasClick(state, SUPPLIER_SPOT.x + 20, SUPPLIER_SPOT.y);
  a.equal(clicked, true);
  a.equal(state.cashiers[1].task, 'supplier');

  for (let i = 0; i < 90; i++) stepGame(state, 0.05, rng);
  a.equal(state.suppliersReceived, 1);
  a.ok(state.stock >= 70, 'El proveedor debe recargar surtido');

  // Clicking register 2 moves selected cashier there (swapping cleanly)
  state.selectedCashier = 0;
  handleCanvasClick(state, REGISTER_XS[2], COUNTER_Y);
  a.equal(state.cashiers[0].task, 'register');
  a.equal(state.cashiers[0].registerIndex, 2);
});

test('motor del minijuego: modo Turno termina al cumplir tiempo y modo Infinito al perder 5 vidas', () => {
  const rng = () => 0.4;
  // Shift mode ends at SHIFT_DURATION_SEC
  const shift = createInitialState('shift', 'afternoon', 'playing');
  shift.elapsed = SHIFT_DURATION_SEC - 0.1;
  shift.score = 21500;
  shift.customersServed = 42;
  shift.customersLost = 2;
  shift.stockIntegral = 75 * shift.elapsed;
  shift.cleanIntegral = 80 * shift.elapsed;
  stepGame(shift, 0.08, rng);
  stepGame(shift, 0.08, rng);
  a.equal(shift.status, 'finished');
  a.equal(shift.grade, 'A');

  // Empty shelves cause browsing customers to walk out empty-handed
  const emptyStore = createInitialState('shift', 'morning', 'playing');
  emptyStore.stock = 4;
  for (let i = 0; i < 120; i++) stepGame(emptyStore, 0.05, rng);
  a.ok(emptyStore.customersLost >= 1, 'Los clientes deben irse si los anaqueles están vacíos');

  // Endless mode ends when 5 customers run out of patience
  const endless = createInitialState('endless', 'morning', 'playing');
  // Move all cashiers off registers so customers wait and leave angry
  assignCashierTask(endless, 0, 'restock');
  assignCashierTask(endless, 1, 'restock');
  assignCashierTask(endless, 2, 'restock');
  endless.stock = 5;
  for (let i = 0; i < 6; i++) {
    endless.customers.push({
      id: 100 + i,
      kind: 'rushed',
      shirtColor: '#ef4444',
      x: REGISTER_XS[0],
      y: 350 - i * 20,
      targetX: REGISTER_XS[0],
      targetY: 350 - i * 20,
      state: 'queueing',
      registerIndex: 0,
      browseTimer: 2,
      browseDuration: 2,
      checkoutProgress: 0,
      checkoutDuration: 2,
      patience: 0.05,
      maxPatience: 12,
      stockDrain: 4,
      dirtAmount: 4,
      saleCents: 9000,
      baseScore: 120,
      hopCooldown: 5,
    });
  }
  stepGame(endless, 0.05, rng);
  a.equal(endless.lives, 0);
  a.equal(endless.status, 'finished');
});

test('API del minijuego: todos los roles guardan puntajes, ven el ranking e idempotencia', async () => {
  // 1. Employee 1 submits a Shift score -> becomes #1
  const match1 = randomUUID();
  const r1 = await api('/minigame/scores', emp1Token, {
    id: match1,
    mode: 'shift',
    score: 2600,
    customers_served: 18,
    sales_cents: 325000,
    grade: 'B',
    duration_seconds: 150,
    max_combo: 3,
    suppliers_received: 2,
  });
  a.equal(r1.status, 200);
  a.equal(r1.body.duplicate, false);
  a.equal(r1.body.is_personal_best, true);
  a.equal(r1.body.is_branch_record, true);
  a.equal(r1.body.leaderboard.length, 1);
  a.equal(r1.body.leaderboard[0].user_id, emp1Id);

  // Resubmitting same match id is idempotent (no duplicate row)
  const dup = await api('/minigame/scores', emp1Token, {
    id: match1,
    mode: 'shift',
    score: 2600,
    customers_served: 18,
    sales_cents: 325000,
    grade: 'B',
    duration_seconds: 150,
    max_combo: 3,
    suppliers_received: 2,
  });
  a.equal(dup.status, 200);
  a.equal(dup.body.duplicate, true);
  a.equal(dup.body.personal.games_played, 1);

  // 2. Admin submits a higher Shift score -> takes #1
  const r2 = await api('/minigame/scores', adminToken, {
    mode: 'shift',
    score: 4850,
    customers_served: 31,
    sales_cents: 580000,
    grade: 'A',
    duration_seconds: 150,
    max_combo: 4,
    suppliers_received: 3,
  });
  a.equal(r2.status, 200);
  a.equal(r2.body.is_branch_record, true);
  a.equal(r2.body.personal.rank, 1);

  // 3. Superadmin submits in branchA -> takes #1 with S grade
  const r3 = await api('/minigame/scores', ownerToken, {
    branch_id: branchA,
    mode: 'shift',
    score: 6100,
    customers_served: 39,
    sales_cents: 745000,
    grade: 'S',
    duration_seconds: 150,
    max_combo: 5,
    suppliers_received: 4,
  });
  a.equal(r3.status, 200);
  a.equal(r3.body.is_branch_record, true);
  a.equal(r3.body.leaderboard.length, 3);
  a.deepEqual(
    r3.body.leaderboard.map((x: any) => x.user_id),
    [ownerId, adminId, emp1Id],
  );

  // 4. Employee 1 plays again with a lower score -> best remains 2600, games_played becomes 2
  const r4 = await api('/minigame/scores', emp1Token, {
    mode: 'shift',
    score: 1400,
    customers_served: 11,
    sales_cents: 170000,
    grade: 'C',
    duration_seconds: 150,
    max_combo: 2,
    suppliers_received: 1,
  });
  a.equal(r4.status, 200);
  a.equal(r4.body.is_personal_best, false);
  a.equal(r4.body.personal.score, 2600);
  a.equal(r4.body.personal.games_played, 2);

  // 5. Endless mode has its own separate leaderboard
  const r5 = await api('/minigame/scores', emp2Token, {
    mode: 'endless',
    score: 3300,
    customers_served: 24,
    sales_cents: 410000,
    grade: 'B',
    duration_seconds: 215,
    max_combo: 4,
    suppliers_received: 2,
  });
  a.equal(r5.status, 200);
  a.equal(r5.body.leaderboard.length, 1);
  a.equal(r5.body.leaderboard[0].user_id, emp2Id);

  // Employee 2 reads Shift leaderboard and sees all 3 players from branchA
  const boardShift = await api('/minigame/leaderboard?mode=shift', emp2Token);
  a.equal(boardShift.status, 200);
  a.equal(boardShift.body.leaderboard.length, 3);
  a.equal(boardShift.body.personal, null);
  a.equal(boardShift.body.best_by_mode.endless.best_score, 3300);
});

test('API del minijuego: aislamiento estricto entre sucursales y validación', async () => {
  // Branch B employee submits score in Branch B
  const rb = await api('/minigame/scores', otherBranchToken, {
    mode: 'shift',
    score: 9999,
    customers_served: 60,
    sales_cents: 900000,
    grade: 'S',
    duration_seconds: 150,
    max_combo: 5,
    suppliers_received: 4,
  });
  a.equal(rb.status, 200);
  a.equal(rb.body.leaderboard.length, 1);

  // Branch A employee does NOT see Branch B's 9999 score
  const boardA = await api('/minigame/leaderboard?mode=shift', emp1Token);
  a.equal(boardA.status, 200);
  a.equal(boardA.body.leaderboard[0].score, 6100);

  // Branch A employee cannot query or write to Branch B
  const crossRead = await api(`/minigame/leaderboard?branch_id=${branchB}&mode=shift`, emp1Token);
  a.equal(crossRead.status, 403);
  const crossWrite = await api('/minigame/scores', emp1Token, {
    branch_id: branchB,
    mode: 'shift',
    score: 500,
    customers_served: 5,
    sales_cents: 50000,
    grade: 'D',
    duration_seconds: 60,
  });
  a.equal(crossWrite.status, 403);

  // Invalid score payload rejected with 400
  const invalid = await api('/minigame/scores', emp1Token, {
    mode: 'shift',
    score: -50,
    customers_served: 5,
    sales_cents: 1000,
    duration_seconds: 60,
  });
  a.equal(invalid.status, 400);
});
