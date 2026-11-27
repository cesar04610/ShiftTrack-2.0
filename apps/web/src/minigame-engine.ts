export type GameMode = 'shift' | 'endless';
export type ShiftPeriod = 'morning' | 'afternoon';
export type GameStatus = 'idle' | 'playing' | 'paused' | 'finished';
export type Specialty = 'checkout' | 'restock' | 'clean';
export type CashierTaskKind = 'register' | 'restock' | 'clean' | 'supplier';
export type CustomerKind = 'normal' | 'cart' | 'rushed' | 'messy';
export type SoundCue =
  | 'assign'
  | 'checkout'
  | 'clean'
  | 'restock'
  | 'supplier_arrive'
  | 'supplier_done'
  | 'rush'
  | 'angry'
  | 'finish';

export const WORLD_W = 800;
export const WORLD_H = 500;
export const SHIFT_DURATION_SEC = 150;
export const ENDLESS_MAX_LIVES = 5;
export const REGISTER_XS = [185, 385, 585] as const;
export const COUNTER_Y = 398;
export const CASHIER_Y = 440;
export const QUEUE_START_Y = 352;
export const QUEUE_STEP_Y = 44;
export const RESTOCK_SPOTS = [
  { x: 145, y: 148 },
  { x: 315, y: 148 },
  { x: 485, y: 148 },
] as const;
export const SUPPLIER_SPOT = { x: 678, y: 158 } as const;
export const ENTRANCE_POS = { x: 34, y: 248 } as const;
export const EXIT_POS = { x: 385, y: 492 } as const;

export type Cashier = {
  id: number;
  name: string;
  shortName: string;
  color: string;
  specialty: Specialty;
  homeRegister: number;
  task: CashierTaskKind;
  registerIndex: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  moving: boolean;
  workAnim: number;
  targetMessId: number | null;
};

export type Customer = {
  id: number;
  kind: CustomerKind;
  shirtColor: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  state: 'browsing' | 'queueing' | 'leaving_happy' | 'leaving_angry';
  registerIndex: number;
  browseTimer: number;
  browseDuration: number;
  checkoutProgress: number;
  checkoutDuration: number;
  patience: number;
  maxPatience: number;
  stockDrain: number;
  dirtAmount: number;
  saleCents: number;
  baseScore: number;
  hopCooldown: number;
  reason?: 'stock' | 'dirt' | 'wait';
};

export type Mess = {
  id: number;
  x: number;
  y: number;
  kind: 'spill' | 'tracks' | 'wrapper';
  color: string;
  progress: number; // 0..1 when being cleaned
  size: number;
};

export type SupplierEvent = {
  active: boolean;
  timeLeft: number;
  maxTime: number;
  progress: number; // 0..1
  duration: number;
  company: string;
};

export type FloatingText = {
  id: number;
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
};

export type Sparkle = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
  maxLife: number;
  size: number;
};

export type GameState = {
  matchId: string;
  mode: GameMode;
  shiftPeriod: ShiftPeriod;
  status: GameStatus;
  elapsed: number;
  timeLeft: number;
  wave: number;
  rushTimeLeft: number;
  nextRushAt: number;
  score: number;
  salesCents: number;
  customersServed: number;
  customersLost: number;
  suppliersReceived: number;
  messesCleaned: number;
  streak: number;
  combo: number;
  maxCombo: number;
  lives: number;
  maxLives: number;
  stock: number; // 0..100
  cleanliness: number; // 0..100
  stockIntegral: number;
  cleanIntegral: number;
  selectedCashier: number;
  cashiers: Cashier[];
  customers: Customer[];
  messes: Mess[];
  supplier: SupplierEvent;
  floatingTexts: FloatingText[];
  sparkles: Sparkle[];
  spawnTimer: number;
  supplierCooldown: number;
  nextEntityId: number;
  grade: '' | 'S' | 'A' | 'B' | 'C' | 'D';
  banner: { text: string; tone: 'rush' | 'supplier' | 'good' | 'warn'; timeLeft: number } | null;
  soundQueue: SoundCue[];
};

const CUSTOMER_SHIRTS: Record<CustomerKind, string[]> = {
  normal: ['#0ea5e9', '#10b981', '#14b8a6', '#6366f1'],
  cart: ['#7c3aed', '#9333ea'],
  rushed: ['#ef4444', '#f43f5e'],
  messy: ['#eab308', '#f59e0b'],
};

const SUPPLIER_COMPANIES = [
  'Refrescos del Norte',
  'Lácteos La Sierra',
  'Abarrotes Central',
  'Panadería del Valle',
  'Botanas Express',
];

const MESS_COLORS = ['#92400e', '#f97316', '#0284c7', '#84cc16', '#b45309'];

const CASHIER_TEMPLATES: Array<{
  id: number;
  name: string;
  shortName: string;
  color: string;
  specialty: Specialty;
}> = [
  { id: 0, name: 'Sofía', shortName: 'SOF', color: '#0f766e', specialty: 'checkout' },
  { id: 1, name: 'Mateo', shortName: 'MAT', color: '#d97706', specialty: 'restock' },
  { id: 2, name: 'Valeria', shortName: 'VAL', color: '#2563eb', specialty: 'clean' },
];

export const SPECIALTY_LABELS: Record<Specialty, string> = {
  checkout: 'Rápida en caja (+28%)',
  restock: 'Rápido rellenando (+28%)',
  clean: 'Rápida limpiando (+28%)',
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return '00000000-0000-4000-8000-000000000000'.replace(/[0]/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

export function createInitialState(
  mode: GameMode,
  shiftPeriod: ShiftPeriod = 'morning',
  status: GameStatus = 'playing',
): GameState {
  const cashiers: Cashier[] = CASHIER_TEMPLATES.map((t, i) => ({
    id: t.id,
    name: t.name,
    shortName: t.shortName,
    color: t.color,
    specialty: t.specialty,
    homeRegister: i,
    task: 'register',
    registerIndex: i,
    x: REGISTER_XS[i],
    y: CASHIER_Y,
    targetX: REGISTER_XS[i],
    targetY: CASHIER_Y,
    moving: false,
    workAnim: 0,
    targetMessId: null,
  }));

  return {
    matchId: makeUuid(),
    mode,
    shiftPeriod,
    status,
    elapsed: 0,
    timeLeft: mode === 'shift' ? SHIFT_DURATION_SEC : 0,
    wave: 1,
    rushTimeLeft: 0,
    nextRushAt: mode === 'shift' ? 42 : 48,
    score: 0,
    salesCents: 0,
    customersServed: 0,
    customersLost: 0,
    suppliersReceived: 0,
    messesCleaned: 0,
    streak: 0,
    combo: 1,
    maxCombo: 1,
    lives: ENDLESS_MAX_LIVES,
    maxLives: ENDLESS_MAX_LIVES,
    stock: 86,
    cleanliness: 92,
    stockIntegral: 0,
    cleanIntegral: 0,
    selectedCashier: 0,
    cashiers,
    customers: [],
    messes: [],
    supplier: {
      active: false,
      timeLeft: 0,
      maxTime: 18,
      progress: 0,
      duration: 2.5,
      company: SUPPLIER_COMPANIES[0],
    },
    floatingTexts: [],
    sparkles: [],
    spawnTimer: 0.5,
    supplierCooldown: 24,
    nextEntityId: 1,
    grade: '',
    banner: null,
    soundQueue: [],
  };
}

function addFloatingText(state: GameState, x: number, y: number, text: string, color: string) {
  state.floatingTexts.push({
    id: state.nextEntityId++,
    x,
    y,
    text,
    color,
    life: 1.35,
    maxLife: 1.35,
  });
}

function spawnSparkles(
  state: GameState,
  x: number,
  y: number,
  color: string,
  count = 6,
  rng = Math.random,
) {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + rng() * 0.5;
    const speed = 28 + rng() * 44;
    state.sparkles.push({
      id: state.nextEntityId++,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 12,
      color,
      life: 0.45 + rng() * 0.25,
      maxLife: 0.7,
      size: 2.5 + rng() * 2.5,
    });
  }
}

export function getRegisterQueue(state: GameState, registerIndex: number): Customer[] {
  return state.customers
    .filter((c) => c.state === 'queueing' && c.registerIndex === registerIndex)
    .sort((a, b) => b.y - a.y || a.id - b.id);
}

export function getCashierAtRegister(state: GameState, registerIndex: number): Cashier | undefined {
  return state.cashiers.find((c) => c.task === 'register' && c.registerIndex === registerIndex);
}

function pickBestRegisterForCashier(state: GameState, cashier: Cashier): number {
  const occupied = new Set(
    state.cashiers
      .filter((c) => c.id !== cashier.id && c.task === 'register')
      .map((c) => c.registerIndex),
  );
  const free = [0, 1, 2].filter((idx) => !occupied.has(idx));
  if (free.length === 0) return cashier.homeRegister;
  // Prefer an unattended register that currently has waiting customers.
  let best = free.includes(cashier.homeRegister) ? cashier.homeRegister : free[0];
  let bestLen = getRegisterQueue(state, best).length;
  for (const idx of free) {
    const len = getRegisterQueue(state, idx).length;
    if (len > bestLen) {
      best = idx;
      bestLen = len;
    }
  }
  return best;
}

export function assignCashierTask(
  state: GameState,
  cashierId: number,
  task: CashierTaskKind,
  registerIndex?: number,
) {
  if (state.status !== 'playing') return;
  const cashier = state.cashiers.find((c) => c.id === cashierId);
  if (!cashier) return;

  if (task === 'supplier' && !state.supplier.active) return;

  if (task === 'register') {
    const targetReg = registerIndex ?? pickBestRegisterForCashier(state, cashier);
    const prevReg = cashier.task === 'register' ? cashier.registerIndex : null;
    const other = state.cashiers.find(
      (c) => c.id !== cashier.id && c.task === 'register' && c.registerIndex === targetReg,
    );
    if (other) {
      // Swap registers cleanly if another cashier was at targetReg.
      const fallback =
        prevReg ??
        [0, 1, 2].find(
          (idx) =>
            idx !== targetReg &&
            !state.cashiers.some(
              (c) => c.id !== other.id && c.task === 'register' && c.registerIndex === idx,
            ),
        ) ??
        other.homeRegister;
      other.registerIndex = fallback;
      other.targetX = REGISTER_XS[fallback];
      other.targetY = CASHIER_Y;
    }
    cashier.task = 'register';
    cashier.registerIndex = targetReg;
    cashier.targetMessId = null;
    cashier.targetX = REGISTER_XS[targetReg];
    cashier.targetY = CASHIER_Y;
  } else if (task === 'restock') {
    cashier.task = 'restock';
    cashier.targetMessId = null;
    const spot = RESTOCK_SPOTS[cashier.id % RESTOCK_SPOTS.length];
    cashier.targetX = spot.x;
    cashier.targetY = spot.y;
  } else if (task === 'clean') {
    cashier.task = 'clean';
    cashier.targetMessId = null;
    const mess = pickMessForCashier(state, cashier);
    if (mess) {
      cashier.targetMessId = mess.id;
      cashier.targetX = mess.x;
      cashier.targetY = mess.y;
    } else {
      cashier.targetX = 240 + cashier.id * 140;
      cashier.targetY = 235;
    }
  } else if (task === 'supplier') {
    cashier.task = 'supplier';
    cashier.targetMessId = null;
    cashier.targetX = SUPPLIER_SPOT.x;
    cashier.targetY = SUPPLIER_SPOT.y;
  }

  state.soundQueue.push('assign');
}

function pickMessForCashier(state: GameState, cashier: Cashier): Mess | undefined {
  if (state.messes.length === 0) return undefined;
  const claimed = new Set(
    state.cashiers
      .filter((c) => c.id !== cashier.id && c.task === 'clean' && c.targetMessId !== null)
      .map((c) => c.targetMessId),
  );
  const pool = state.messes.filter((m) => !claimed.has(m.id));
  const candidates = pool.length ? pool : state.messes;
  let nearest = candidates[0];
  let bestDist = Infinity;
  for (const m of candidates) {
    const d = Math.hypot(m.x - cashier.x, m.y - cashier.y);
    if (d < bestDist) {
      bestDist = d;
      nearest = m;
    }
  }
  return nearest;
}

function spawnMess(state: GameState, x: number, y: number, big: boolean, rng: () => number) {
  if (state.messes.length >= 10) return;
  const clampedX = clamp(x + (rng() - 0.5) * 44, 110, 620);
  const clampedY = clamp(y + (rng() - 0.5) * 36, 175, 295);
  const kinds: Mess['kind'][] = big ? ['spill'] : ['spill', 'tracks', 'wrapper'];
  const kind = kinds[Math.floor(rng() * kinds.length)];
  state.messes.push({
    id: state.nextEntityId++,
    x: clampedX,
    y: clampedY,
    kind,
    color: MESS_COLORS[Math.floor(rng() * MESS_COLORS.length)],
    progress: 0,
    size: big ? 17 : 12 + rng() * 4,
  });
}

function pickCustomerRegister(state: GameState): number {
  let bestReg = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 3; i++) {
    const queueLen = state.customers.filter(
      (c) => c.state === 'queueing' && c.registerIndex === i,
    ).length;
    const hasCashier = state.cashiers.some((c) => c.task === 'register' && c.registerIndex === i);
    const score = queueLen * 2 + (hasCashier ? 0 : 3.5);
    if (score < bestScore) {
      bestScore = score;
      bestReg = i;
    }
  }
  return bestReg;
}

function spawnCustomer(state: GameState, rng: () => number) {
  // Keep total active customers bounded so queues stay readable.
  const activeCount = state.customers.filter(
    (c) => c.state === 'browsing' || c.state === 'queueing',
  ).length;
  if (activeCount >= 14) return;

  const intensity =
    state.mode === 'shift'
      ? clamp(state.elapsed / SHIFT_DURATION_SEC, 0, 1)
      : clamp((state.wave - 1) / 7, 0, 1);

  const roll = rng();
  let kind: CustomerKind = 'normal';
  const rushedChance = 0.12 + intensity * 0.14;
  const cartChance = 0.14 + intensity * 0.1;
  const messyChance = 0.13 + intensity * 0.11;
  if (roll < rushedChance) kind = 'rushed';
  else if (roll < rushedChance + cartChance) kind = 'cart';
  else if (roll < rushedChance + cartChance + messyChance) kind = 'messy';

  const specs: Record<
    CustomerKind,
    {
      checkout: number;
      patience: number;
      stockDrain: number;
      dirt: number;
      minSale: number;
      maxSale: number;
      score: number;
    }
  > = {
    normal: {
      checkout: 2.5,
      patience: 21,
      stockDrain: 5.5,
      dirt: 4.5,
      minSale: 8500,
      maxSale: 16500,
      score: 100,
    },
    cart: {
      checkout: 4.1,
      patience: 24,
      stockDrain: 10.5,
      dirt: 6.5,
      minSale: 26000,
      maxSale: 43000,
      score: 210,
    },
    rushed: {
      checkout: 1.75,
      patience: 13.5,
      stockDrain: 4.2,
      dirt: 4.0,
      minSale: 5500,
      maxSale: 11000,
      score: 145,
    },
    messy: {
      checkout: 2.5,
      patience: 19.5,
      stockDrain: 6.2,
      dirt: 13.0,
      minSale: 11000,
      maxSale: 19500,
      score: 130,
    },
  };

  const s = specs[kind];
  const palette = CUSTOMER_SHIRTS[kind];
  const shirtColor = palette[Math.floor(rng() * palette.length)];
  const browseX = 115 + rng() * 490;
  const browseY = 175 + rng() * 88;
  const saleCents = Math.round((s.minSale + rng() * (s.maxSale - s.minSale)) / 500) * 500;

  state.customers.push({
    id: state.nextEntityId++,
    kind,
    shirtColor,
    x: ENTRANCE_POS.x,
    y: ENTRANCE_POS.y,
    targetX: browseX,
    targetY: browseY,
    state: 'browsing',
    registerIndex: 0,
    browseTimer: 0,
    browseDuration: 1.1 + rng() * 0.8,
    checkoutProgress: 0,
    checkoutDuration: s.checkout,
    patience: s.patience,
    maxPatience: s.patience,
    stockDrain: s.stockDrain,
    dirtAmount: s.dirt,
    saleCents,
    baseScore: s.score,
    hopCooldown: 1.8,
  });
}

export function computeGrade(state: GameState): 'S' | 'A' | 'B' | 'C' | 'D' {
  const total = state.customersServed + state.customersLost;
  const satisfaction = total > 0 ? state.customersServed / total : 0;
  const avgStock = state.elapsed > 0 ? state.stockIntegral / state.elapsed : state.stock;
  const avgClean = state.elapsed > 0 ? state.cleanIntegral / state.elapsed : state.cleanliness;
  const upkeep = (avgStock + avgClean) / 2;

  if (state.score >= 5500 && satisfaction >= 0.9 && upkeep >= 68) return 'S';
  if (state.score >= 3800 && satisfaction >= 0.8 && upkeep >= 55) return 'A';
  if (state.score >= 2200 && satisfaction >= 0.65) return 'B';
  if (state.score >= 1000 || state.customersServed >= 8) return 'C';
  return 'D';
}

export function formatShiftClock(state: GameState): string {
  const progress = clamp(state.elapsed / SHIFT_DURATION_SEC, 0, 1);
  // Mañana: 07:30 -> 15:00 (450 min). Tarde: 15:00 -> 21:30 (390 min).
  const startMin = state.shiftPeriod === 'morning' ? 7 * 60 + 30 : 15 * 60;
  const spanMin = state.shiftPeriod === 'morning' ? 450 : 390;
  const totalMin = Math.floor(startMin + progress * spanMin);
  const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
  const mm = String(totalMin % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function stepGame(state: GameState, rawDt: number, rng: () => number = Math.random): void {
  if (state.status !== 'playing') return;
  const dt = clamp(rawDt, 0, 0.1);

  state.elapsed += dt;
  state.stockIntegral += state.stock * dt;
  state.cleanIntegral += state.cleanliness * dt;

  // Update banner timer
  if (state.banner) {
    state.banner.timeLeft -= dt;
    if (state.banner.timeLeft <= 0) state.banner = null;
  }

  // Mode clock / waves
  if (state.mode === 'shift') {
    state.timeLeft = Math.max(0, SHIFT_DURATION_SEC - state.elapsed);
    state.wave = 1 + Math.floor(state.elapsed / 35);
    if (state.timeLeft <= 0) {
      state.status = 'finished';
      state.grade = computeGrade(state);
      state.soundQueue.push('finish');
      return;
    }
  } else {
    state.wave = 1 + Math.floor(state.elapsed / 25);
  }

  // Rush hour event trigger
  if (state.rushTimeLeft > 0) {
    state.rushTimeLeft = Math.max(0, state.rushTimeLeft - dt);
  } else if (state.elapsed >= state.nextRushAt) {
    state.rushTimeLeft = 17;
    state.nextRushAt = state.elapsed + (state.mode === 'shift' ? 58 : 52);
    state.banner = { text: '¡HORA PICO! Llegan oleadas de clientes', tone: 'rush', timeLeft: 4.2 };
    state.soundQueue.push('rush');
  }

  // Supplier event trigger & timer
  if (state.supplier.active) {
    state.supplier.timeLeft -= dt;
    if (state.supplier.timeLeft <= 0) {
      state.supplier.active = false;
      state.supplier.progress = 0;
      state.supplierCooldown = 28 + rng() * 10;
      addFloatingText(
        state,
        SUPPLIER_SPOT.x - 10,
        SUPPLIER_SPOT.y - 24,
        'Proveedor se fue',
        '#dc2626',
      );
      // Return any cashier waiting on supplier back to register
      for (const c of state.cashiers) {
        if (c.task === 'supplier') assignCashierTask(state, c.id, 'register');
      }
    }
  } else {
    state.supplierCooldown -= dt;
    if (state.supplierCooldown <= 0 && (state.stock < 80 || state.elapsed > 30)) {
      state.supplier = {
        active: true,
        timeLeft: 18,
        maxTime: 18,
        progress: 0,
        duration: 2.4,
        company: SUPPLIER_COMPANIES[Math.floor(rng() * SUPPLIER_COMPANIES.length)],
      };
      state.banner = {
        text: `¡Llegó ${state.supplier.company}! Manda un cajero a recibir`,
        tone: 'supplier',
        timeLeft: 4.5,
      };
      state.soundQueue.push('supplier_arrive');
    }
  }

  // Customer spawning
  const baseInterval =
    state.mode === 'shift'
      ? Math.max(1.55, 3.6 - (state.elapsed / SHIFT_DURATION_SEC) * 1.75)
      : Math.max(1.15, 3.5 - (state.wave - 1) * 0.28);
  const spawnInterval = state.rushTimeLeft > 0 ? baseInterval * 0.56 : baseInterval;

  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0) {
    spawnCustomer(state, rng);
    state.spawnTimer = spawnInterval * (0.78 + rng() * 0.44);
  }

  // Move & work cashiers
  const cashierSpeed = 245;
  for (const c of state.cashiers) {
    if (c.task === 'clean') {
      const currentMess =
        c.targetMessId !== null ? state.messes.find((m) => m.id === c.targetMessId) : undefined;
      if (!currentMess) {
        const nextMess = pickMessForCashier(state, c);
        if (nextMess) {
          c.targetMessId = nextMess.id;
          c.targetX = nextMess.x;
          c.targetY = nextMess.y;
        } else {
          c.targetMessId = null;
        }
      }
    }

    const dx = c.targetX - c.x;
    const dy = c.targetY - c.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 4) {
      c.moving = true;
      const step = Math.min(dist, cashierSpeed * dt);
      c.x += (dx / dist) * step;
      c.y += (dy / dist) * step;
      c.workAnim += dt * 10;
    } else {
      c.x = c.targetX;
      c.y = c.targetY;
      c.moving = false;
      c.workAnim += dt * 6;

      // Perform assigned work
      if (c.task === 'restock') {
        const mult = c.specialty === 'restock' ? 1.28 : 1;
        const before = state.stock;
        state.stock = clamp(state.stock + 12.5 * mult * dt, 0, 100);
        if (Math.floor(before / 20) < Math.floor(state.stock / 20)) {
          spawnSparkles(state, c.x, c.y - 26, '#10b981', 5, rng);
          state.soundQueue.push('restock');
        }
        if (state.stock >= 100) {
          addFloatingText(state, c.x, c.y - 30, '¡Anaqueles llenos!', '#059669');
          spawnSparkles(state, c.x, c.y - 26, '#34d399', 8, rng);
          state.score += 35;
          assignCashierTask(state, c.id, 'register');
        }
      } else if (c.task === 'clean') {
        const mult = c.specialty === 'clean' ? 1.28 : 1;
        const mess =
          c.targetMessId !== null ? state.messes.find((m) => m.id === c.targetMessId) : undefined;
        if (mess) {
          mess.progress += (dt * mult) / 1.45;
          state.cleanliness = clamp(state.cleanliness + 5.5 * mult * dt, 0, 100);
          if (mess.progress >= 1) {
            state.messes = state.messes.filter((m) => m.id !== mess.id);
            c.targetMessId = null;
            state.messesCleaned += 1;
            state.cleanliness = clamp(state.cleanliness + 11, 0, 100);
            state.score += 40;
            addFloatingText(state, mess.x, mess.y - 12, '¡Limpio! +40', '#0284c7');
            spawnSparkles(state, mess.x, mess.y, '#38bdf8', 8, rng);
            state.soundQueue.push('clean');
          }
        } else {
          // Polish general cleanliness when no big spills remain
          state.cleanliness = clamp(state.cleanliness + 14 * mult * dt, 0, 100);
          if (state.cleanliness >= 100 && state.messes.length === 0) {
            addFloatingText(state, c.x, c.y - 24, '¡Piso reluciente!', '#0284c7');
            spawnSparkles(state, c.x, c.y, '#38bdf8', 7, rng);
            assignCashierTask(state, c.id, 'register');
          }
        }
      } else if (c.task === 'supplier' && state.supplier.active) {
        const mult = c.specialty === 'restock' ? 1.22 : 1;
        state.supplier.progress += (dt * mult) / state.supplier.duration;
        if (state.supplier.progress >= 1) {
          state.supplier.active = false;
          state.supplier.progress = 0;
          state.supplierCooldown = 32 + rng() * 10;
          state.suppliersReceived += 1;
          state.stock = clamp(state.stock + 38, 0, 100);
          const bonus = 220 * state.combo;
          state.score += bonus;
          addFloatingText(
            state,
            SUPPLIER_SPOT.x - 20,
            SUPPLIER_SPOT.y - 26,
            `¡Proveedor! +38% surtido (+${bonus})`,
            '#059669',
          );
          spawnSparkles(state, SUPPLIER_SPOT.x, SUPPLIER_SPOT.y, '#f59e0b', 12, rng);
          state.banner = {
            text: `¡Pedido recibido! +38% surtido y +${bonus} pts`,
            tone: 'good',
            timeLeft: 3.2,
          };
          state.soundQueue.push('supplier_done');
          for (const other of state.cashiers) {
            if (other.task === 'supplier') assignCashierTask(state, other.id, 'register');
          }
        }
      }
    }
  }

  // Update browsing customers -> transition to queueing
  const custSpeed = 145;
  for (const cust of state.customers) {
    if (cust.state === 'browsing') {
      const dx = cust.targetX - cust.x;
      const dy = cust.targetY - cust.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 4) {
        const step = Math.min(dist, custSpeed * dt);
        cust.x += (dx / dist) * step;
        cust.y += (dy / dist) * step;
      } else {
        cust.browseTimer += dt;
        if (cust.browseTimer >= cust.browseDuration) {
          // Customer takes products from shelves & dirties the store!
          state.stock = clamp(state.stock - cust.stockDrain, 0, 100);
          state.cleanliness = clamp(state.cleanliness - cust.dirtAmount, 0, 100);
          if (cust.kind === 'messy' || rng() < 0.52) {
            spawnMess(state, cust.x, cust.y, cust.kind === 'messy', rng);
          }
          cust.state = 'queueing';
          cust.registerIndex = pickCustomerRegister(state);
        }
      }
    } else if (cust.state === 'leaving_happy' || cust.state === 'leaving_angry') {
      const dx = cust.targetX - cust.x;
      const dy = cust.targetY - cust.y;
      const dist = Math.hypot(dx, dy);
      const leaveSpeed = cust.state === 'leaving_angry' ? 195 : 165;
      if (dist > 4) {
        const step = Math.min(dist, leaveSpeed * dt);
        cust.x += (dx / dist) * step;
        cust.y += (dy / dist) * step;
      } else {
        cust.y = WORLD_H + 40;
      }
    }
  }

  // Process register queues & checkouts
  const stockPenalty = state.stock <= 5 ? 2.15 : state.stock < 35 ? 1.45 : 1;
  const dirtPenalty =
    state.cleanliness <= 10 ? 2.05 : state.cleanliness < 40 || state.messes.length >= 4 ? 1.45 : 1;
  const envPatienceMult = Math.max(stockPenalty, dirtPenalty);

  for (let reg = 0; reg < 3; reg++) {
    const queue = getRegisterQueue(state, reg);
    const cashier = getCashierAtRegister(state, reg);
    const cashierReady = !!cashier && !cashier.moving;

    queue.forEach((cust, idx) => {
      // Position smoothly in lane
      const slotX = REGISTER_XS[reg];
      const slotY = QUEUE_START_Y - idx * QUEUE_STEP_Y;
      const dx = slotX - cust.x;
      const dy = slotY - cust.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 3) {
        const step = Math.min(dist, custSpeed * 1.15 * dt);
        cust.x += (dx / dist) * step;
        cust.y += (dy / dist) * step;
      } else {
        cust.x = slotX;
        cust.y = slotY;
      }

      // Allow back-of-line customer at unattended lane to hop to a shorter open lane
      if (!cashier && idx === queue.length - 1) {
        cust.hopCooldown -= dt;
        if (cust.hopCooldown <= 0) {
          cust.hopCooldown = 1.6;
          for (let alt = 0; alt < 3; alt++) {
            if (alt === reg) continue;
            const altCashier = getCashierAtRegister(state, alt);
            if (!altCashier) continue;
            const altLen = getRegisterQueue(state, alt).length;
            if (altLen < queue.length) {
              cust.registerIndex = alt;
              break;
            }
          }
        }
      }

      // Front customer gets checked out if cashier is ready at counter
      const atFront = idx === 0 && dist < 16;
      if (atFront && cashierReady && cashier) {
        const speedMult = cashier.specialty === 'checkout' ? 1.28 : 1;
        // Very low stock slows checkout slightly ("checking if we have it")
        const stockSlow = state.stock <= 10 ? 0.72 : 1;
        cust.checkoutProgress += (dt * speedMult * stockSlow) / cust.checkoutDuration;
        // Patience drains much slower while actively being served
        cust.patience -= dt * 0.25 * envPatienceMult;

        if (cust.checkoutProgress >= 1) {
          cust.state = 'leaving_happy';
          cust.targetX = REGISTER_XS[reg] + (reg === 0 ? -36 : reg === 2 ? 36 : 0);
          cust.targetY = WORLD_H + 26;
          state.customersServed += 1;
          state.salesCents += cust.saleCents;

          // Combo upkeep: clean & well-stocked store builds combo faster!
          const storeHealthy = state.stock >= 60 && state.cleanliness >= 60;
          state.streak = storeHealthy ? state.streak + 1 : Math.max(1, state.streak);
          const newCombo = clamp(1 + Math.floor(state.streak / 3), 1, 5);
          state.combo = newCombo;
          if (newCombo > state.maxCombo) state.maxCombo = newCombo;

          const patienceRatio = cust.patience / cust.maxPatience;
          const speedBonus = patienceRatio > 0.65 ? 35 : patienceRatio > 0.35 ? 15 : 0;
          const points = Math.round((cust.baseScore + speedBonus) * state.combo);
          state.score += points;

          const pesos = Math.round(cust.saleCents / 100);
          addFloatingText(
            state,
            REGISTER_XS[reg],
            COUNTER_Y - 30,
            `+$${pesos} · +${points} pts${state.combo > 1 ? ` x${state.combo}` : ''}`,
            '#059669',
          );
          spawnSparkles(state, REGISTER_XS[reg], COUNTER_Y - 12, '#10b981', 6, rng);
          state.soundQueue.push('checkout');
        }
      } else {
        // Waiting in queue
        cust.patience -= dt * envPatienceMult;
      }

      if (cust.patience <= 0 && cust.state === 'queueing') {
        cust.state = 'leaving_angry';
        cust.targetX = ENTRANCE_POS.x - 30;
        cust.targetY = ENTRANCE_POS.y;
        cust.reason =
          stockPenalty > 1 && stockPenalty >= dirtPenalty
            ? 'stock'
            : dirtPenalty > 1
              ? 'dirt'
              : 'wait';
        state.customersLost += 1;
        state.streak = 0;
        state.combo = 1;
        const msg =
          cust.reason === 'stock'
            ? '¡Sin surtido!'
            : cust.reason === 'dirt'
              ? '¡Muy sucio!'
              : '¡Mucha espera!';
        addFloatingText(state, cust.x, cust.y - 24, msg, '#dc2626');
        state.soundQueue.push('angry');

        if (state.mode === 'endless') {
          state.lives = Math.max(0, state.lives - 1);
          if (state.lives <= 0) {
            state.status = 'finished';
            state.grade = computeGrade(state);
            state.soundQueue.push('finish');
          }
        }
      }
    });
  }

  // Clean up departed customers
  state.customers = state.customers.filter(
    (c) =>
      c.state === 'browsing' ||
      c.state === 'queueing' ||
      (c.x > -24 && c.x < WORLD_W + 24 && c.y < WORLD_H + 24),
  );

  // Update floating texts
  for (const ft of state.floatingTexts) {
    ft.y -= 28 * dt;
    ft.life -= dt;
  }
  state.floatingTexts = state.floatingTexts.filter((ft) => ft.life > 0);

  // Update sparkles
  for (const sp of state.sparkles) {
    sp.x += sp.vx * dt;
    sp.y += sp.vy * dt;
    sp.life -= dt;
  }
  state.sparkles = state.sparkles.filter((sp) => sp.life > 0);
}

/** Hit-testing for direct clicks/taps on the top-down store map. */
export function handleCanvasClick(state: GameState, x: number, y: number): boolean {
  if (state.status !== 'playing') return false;

  // 1. Clicking directly on a cashier selects them
  for (const c of state.cashiers) {
    if (Math.hypot(x - c.x, y - c.y) <= 28) {
      state.selectedCashier = c.id;
      return true;
    }
  }

  // 2. Clicking the supplier receiving bay assigns selected cashier to supplier (when active)
  if (state.supplier.active && x >= 655 && x <= 795 && y >= 72 && y <= 230) {
    assignCashierTask(state, state.selectedCashier, 'supplier');
    return true;
  }

  // 3. Clicking on the shelves zone assigns selected cashier to restock
  if (x >= 40 && x <= 635 && y >= 20 && y <= 155) {
    assignCashierTask(state, state.selectedCashier, 'restock');
    return true;
  }

  // 4. Clicking on a register lane / counter assigns selected cashier to that exact register
  if (y >= 330 && y <= 485) {
    for (let i = 0; i < 3; i++) {
      if (Math.abs(x - REGISTER_XS[i]) <= 84) {
        assignCashierTask(state, state.selectedCashier, 'register', i);
        return true;
      }
    }
  }

  // 5. Clicking on a floor mess or middle floor assigns selected cashier to clean
  for (const m of state.messes) {
    if (Math.hypot(x - m.x, y - m.y) <= 32) {
      assignCashierTask(state, state.selectedCashier, 'clean');
      const cashier = state.cashiers[state.selectedCashier];
      if (cashier) {
        cashier.targetMessId = m.id;
        cashier.targetX = m.x;
        cashier.targetY = m.y;
      }
      return true;
    }
  }
  if (x >= 75 && x <= 645 && y >= 165 && y <= 325) {
    assignCashierTask(state, state.selectedCashier, 'clean');
    return true;
  }

  return false;
}
