import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Award,
  Clock,
  Crown,
  Flame,
  Gamepad2,
  Heart,
  Package,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Store,
  Trophy,
  Truck,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import { money, type User } from '../../../packages/domain/index.js';
import { hasOnlineSession, request } from './api';
import {
  COUNTER_Y,
  ENTRANCE_POS,
  REGISTER_XS,
  SPECIALTY_LABELS,
  WORLD_H,
  WORLD_W,
  assignCashierTask,
  createInitialState,
  formatShiftClock,
  getCashierAtRegister,
  getRegisterQueue,
  handleCanvasClick,
  stepGame,
  type CashierTaskKind,
  type GameMode,
  type GameState,
  type ShiftPeriod,
  type SoundCue,
} from './minigame-engine';

type LeaderboardRow = {
  rank: number;
  id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  user_active: boolean;
  mode: GameMode;
  score: number;
  customers_served: number;
  sales_cents: string;
  grade: string;
  duration_seconds: number;
  max_combo: number;
  suppliers_received: number;
  played_at: string;
  games_played: number;
};

type RecentRow = {
  id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  mode: GameMode;
  score: number;
  customers_served: number;
  grade: string;
  played_at: string;
};

type BoardResponse = {
  branch_id: string;
  branch_name: string;
  mode: GameMode;
  leaderboard: LeaderboardRow[];
  personal: LeaderboardRow | null;
  recent: RecentRow[];
  best_by_mode: Record<GameMode, { best_score: number; games_played: number }>;
};

type QueuedScore = {
  branch_id: string;
  id: string;
  mode: GameMode;
  score: number;
  customers_served: number;
  sales_cents: number;
  grade: '' | 'S' | 'A' | 'B' | 'C' | 'D';
  duration_seconds: number;
  max_combo: number;
  suppliers_received: number;
};

type HudSnapshot = {
  status: GameState['status'];
  mode: GameMode;
  shiftPeriod: ShiftPeriod;
  score: number;
  salesCents: number;
  customersServed: number;
  customersLost: number;
  suppliersReceived: number;
  messesCleaned: number;
  combo: number;
  maxCombo: number;
  streak: number;
  lives: number;
  maxLives: number;
  stock: number;
  cleanliness: number;
  messCount: number;
  timeLeft: number;
  elapsed: number;
  shiftClock: string;
  wave: number;
  rushActive: boolean;
  rushSecondsLeft: number;
  supplierActive: boolean;
  supplierCompany: string;
  supplierTimeLeft: number;
  selectedCashier: number;
  grade: GameState['grade'];
  banner: GameState['banner'];
  cashiers: Array<{
    id: number;
    name: string;
    color: string;
    specialty: GameState['cashiers'][number]['specialty'];
    task: CashierTaskKind;
    registerIndex: number;
    moving: boolean;
  }>;
};

const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Súper admin',
  admin: 'Admin',
  employee: 'Empleado',
};

const SPECIALTY_EMOJI: Record<GameState['cashiers'][number]['specialty'], string> = {
  checkout: '🏪',
  restock: '📦',
  clean: '🧹',
};

const HAIR_PALETTE = ['#292524', '#78350f', '#1e293b', '#92400e', '#451a03', '#a16207'];

const QUEUE_KEY = 'shifttrack-minigame-pending-v1';

function cacheKey(branchId: string, mode: GameMode) {
  return `shifttrack-minigame-board-v1:${branchId}:${mode}`;
}

function readQueuedScores(): QueuedScore[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueuedScores(items: QueuedScore[]) {
  try {
    if (items.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
    else localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* Storage optional */
  }
}

function readCachedBoard(branchId: string, mode: GameMode): BoardResponse | null {
  try {
    const raw = localStorage.getItem(cacheKey(branchId, mode));
    return raw ? (JSON.parse(raw) as BoardResponse) : null;
  } catch {
    return null;
  }
}

function writeCachedBoard(branchId: string, mode: GameMode, data: BoardResponse) {
  try {
    localStorage.setItem(cacheKey(branchId, mode), JSON.stringify(data));
  } catch {
    /* Storage optional */
  }
}

function formatTimer(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return 'ahora';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr} h`;
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

function snapshotHud(s: GameState): HudSnapshot {
  return {
    status: s.status,
    mode: s.mode,
    shiftPeriod: s.shiftPeriod,
    score: s.score,
    salesCents: s.salesCents,
    customersServed: s.customersServed,
    customersLost: s.customersLost,
    suppliersReceived: s.suppliersReceived,
    messesCleaned: s.messesCleaned,
    combo: s.combo,
    maxCombo: s.maxCombo,
    streak: s.streak,
    lives: s.lives,
    maxLives: s.maxLives,
    stock: Math.round(s.stock),
    cleanliness: Math.round(s.cleanliness),
    messCount: s.messes.length,
    timeLeft: s.timeLeft,
    elapsed: s.elapsed,
    shiftClock: formatShiftClock(s),
    wave: s.wave,
    rushActive: s.rushTimeLeft > 0,
    rushSecondsLeft: Math.ceil(s.rushTimeLeft),
    supplierActive: s.supplier.active,
    supplierCompany: s.supplier.company,
    supplierTimeLeft: Math.ceil(s.supplier.timeLeft),
    selectedCashier: s.selectedCashier,
    grade: s.grade,
    banner: s.banner ? { ...s.banner } : null,
    cashiers: s.cashiers.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      specialty: c.specialty,
      task: c.task,
      registerIndex: c.registerIndex,
      moving: c.moving,
    })),
  };
}

// Lightweight synthesized Web Audio SFX (zero external assets, respects mute toggle)
class SoundPlayer {
  private ctx: AudioContext | null = null;

  private ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx) this.ctx = new AudioCtx();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
  }

  private tone(freq: number, dur: number, type: OscillatorType, gainVal: number, delay = 0) {
    const ctx = this.ensure();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(gainVal, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  play(cue: SoundCue) {
    try {
      if (cue === 'assign') {
        this.tone(440, 0.055, 'triangle', 0.05);
      } else if (cue === 'checkout') {
        this.tone(660, 0.08, 'sine', 0.07, 0);
        this.tone(990, 0.13, 'sine', 0.07, 0.06);
      } else if (cue === 'combo_up') {
        this.tone(587, 0.08, 'triangle', 0.075, 0);
        this.tone(784, 0.09, 'triangle', 0.075, 0.07);
        this.tone(1174, 0.18, 'sine', 0.08, 0.14);
      } else if (cue === 'clean') {
        this.tone(540, 0.07, 'sine', 0.06, 0);
        this.tone(720, 0.07, 'sine', 0.06, 0.055);
        this.tone(960, 0.1, 'sine', 0.055, 0.11);
      } else if (cue === 'restock') {
        this.tone(480, 0.07, 'triangle', 0.06, 0);
        this.tone(640, 0.09, 'triangle', 0.06, 0.06);
      } else if (cue === 'supplier_arrive') {
        this.tone(587, 0.12, 'triangle', 0.08, 0);
        this.tone(880, 0.18, 'triangle', 0.08, 0.12);
      } else if (cue === 'supplier_done') {
        this.tone(523, 0.09, 'sine', 0.07, 0);
        this.tone(659, 0.09, 'sine', 0.07, 0.08);
        this.tone(784, 0.09, 'sine', 0.07, 0.16);
        this.tone(1046, 0.2, 'sine', 0.08, 0.24);
      } else if (cue === 'rush') {
        this.tone(440, 0.1, 'sawtooth', 0.045, 0);
        this.tone(554, 0.1, 'sawtooth', 0.045, 0.1);
        this.tone(659, 0.16, 'sawtooth', 0.045, 0.2);
      } else if (cue === 'angry') {
        this.tone(240, 0.14, 'sawtooth', 0.06, 0);
        this.tone(175, 0.2, 'sawtooth', 0.06, 0.11);
      } else if (cue === 'finish') {
        this.tone(523, 0.12, 'triangle', 0.08, 0);
        this.tone(659, 0.12, 'triangle', 0.08, 0.11);
        this.tone(784, 0.14, 'triangle', 0.08, 0.22);
        this.tone(1046, 0.28, 'triangle', 0.09, 0.34);
      }
    } catch {
      /* Ignore audio errors if blocked by browser policy */
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // Terracotta pot + cozy leafy bush
  ctx.beginPath();
  ctx.arc(x + 2, y + 3, 14, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.1)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 13, 0, Math.PI * 2);
  ctx.fillStyle = '#c2410c';
  ctx.fill();

  const leaves = [
    [-5, -4, 7, '#15803d'],
    [5, -4, 7, '#16a34a'],
    [0, 5, 7, '#15803d'],
    [-5, 3, 6, '#22c55e'],
    [5, 3, 6, '#16a34a'],
    [0, -1, 6, '#4ade80'],
  ] as const;
  for (const [lx, ly, r, col] of leaves) {
    ctx.beginPath();
    ctx.arc(x + lx, y + ly, r, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  }
}

const SHELF_UNITS = [
  {
    x: 58,
    label: 'Abarrotes',
    kind: 'boxes' as const,
    frame: '#7c2d12',
    inner: '#fef3c7',
    items: ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#ec4899'],
  },
  {
    x: 204,
    label: 'Bebidas',
    kind: 'bottles' as const,
    frame: '#0f4c5c',
    inner: '#ecfeff',
    items: ['#0ea5e9', '#10b981', '#dc2626', '#06b6d4', '#f59e0b', '#6366f1'],
  },
  {
    x: 350,
    label: 'Botanas',
    kind: 'bags' as const,
    frame: '#78350f',
    inner: '#fffbeb',
    items: ['#f59e0b', '#ef4444', '#84cc16', '#a855f7', '#fb923c', '#14b8a6'],
  },
  {
    x: 496,
    label: 'Lácteos',
    kind: 'fridge' as const,
    frame: '#0369a1',
    inner: '#e0f2fe',
    items: ['#38bdf8', '#ffffff', '#fde047', '#60a5fa', '#e2e8f0', '#34d399'],
  },
];

function drawStore(ctx: CanvasRenderingContext2D, state: GameState, accentColor: string) {
  const pulse = 0.5 + 0.5 * Math.sin(state.elapsed * 7);

  // 1. Warm cozy checkerboard store floor
  const tile = 40;
  for (let ty = 0; ty < WORLD_H; ty += tile) {
    for (let tx = 0; tx < WORLD_W; tx += tile) {
      const even = ((tx / tile + ty / tile) & 1) === 0;
      ctx.fillStyle = even ? '#faf7f2' : '#f3eee4';
      ctx.fillRect(tx, ty, tile, tile);
    }
  }

  // Soft interior wall shadow & crisp store frame
  ctx.fillStyle = 'rgba(15, 23, 42, 0.045)';
  ctx.fillRect(10, 10, WORLD_W - 20, 12);
  ctx.fillRect(10, 10, 10, WORLD_H - 20);

  ctx.strokeStyle = '#d6cfc2';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, WORLD_W - 10, WORLD_H - 10);

  // Decorative potted plants in cozy store corners
  drawPlant(ctx, 29, 36);
  drawPlant(ctx, 766, 36);
  drawPlant(ctx, 766, 462);

  // Subtle floor zone hint during opening seconds, or dirty-floor warning pill
  const dirtyFloor = state.cleanliness < 40 || state.messes.length >= 4;
  if (dirtyFloor) {
    roundRect(ctx, 284, 165, 142, 23, 11);
    ctx.fillStyle = `rgba(220, 38, 38, ${0.84 + pulse * 0.16})`;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 11px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🧹 ¡PISO MUY SUCIO!', 355, 180);
  } else if (state.elapsed < 6) {
    ctx.save();
    ctx.globalAlpha = clamp01(1 - Math.max(0, state.elapsed - 3.5) / 2.5);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 10.5px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TOCA UNA MANCHA PARA LIMPIAR', 355, 188);
    ctx.restore();
  }

  // Left entrance sliding glass door + welcoming mat
  roundRect(ctx, 10, ENTRANCE_POS.y - 40, 48, 80, 9);
  ctx.fillStyle = '#d1fae5';
  ctx.fill();
  ctx.strokeStyle = '#34d399';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Door threshold bar
  ctx.fillStyle = '#059669';
  ctx.fillRect(6, ENTRANCE_POS.y - 36, 5, 72);
  ctx.save();
  ctx.translate(32, ENTRANCE_POS.y);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#065f46';
  ctx.font = '800 10px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ENTRADA ▸', 0, 4);
  ctx.restore();

  // Bottom exit door mat
  roundRect(ctx, 128, WORLD_H - 15, 514, 13, 5);
  ctx.fillStyle = '#e2e8f0';
  ctx.fill();
  ctx.fillStyle = '#94a3b8';
  ctx.font = '700 8.5px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SALIDA · ¡GRACIAS POR SU COMPRA!', 385, WORLD_H - 5.5);

  // 2. Top Illustrated Shelves Zone (Surtido)
  const lowStock = state.stock < 35;
  roundRect(ctx, 44, 24, 594, 116, 15);
  ctx.fillStyle = lowStock
    ? `rgba(254, 226, 226, ${0.52 + pulse * 0.32})`
    : 'rgba(255, 255, 255, 0.72)';
  ctx.fill();
  ctx.strokeStyle = lowStock ? '#ef4444' : '#e2dbd0';
  ctx.lineWidth = lowStock ? 2.5 : 1.5;
  ctx.stroke();

  const totalSlots = 24;
  const filledSlots = Math.round((state.stock / 100) * totalSlots);

  SHELF_UNITS.forEach((unit, sIdx) => {
    // Gondola shadow
    roundRect(ctx, unit.x + 3, 39, 128, 74, 10);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.11)';
    ctx.fill();

    // Gondola frame
    roundRect(ctx, unit.x, 34, 128, 74, 10);
    ctx.fillStyle = unit.frame;
    ctx.fill();
    roundRect(ctx, unit.x + 5, 39, 118, 64, 7);
    ctx.fillStyle = unit.inner;
    ctx.fill();

    // Shelf divider
    ctx.fillStyle = unit.kind === 'fridge' ? '#7dd3fc' : '#d97706';
    ctx.fillRect(unit.x + 5, 70, 118, 3);

    // Draw individual themed items (6 per shelf = 24 total)
    unit.items.forEach((itemColor, iIdx) => {
      const slotNumber = iIdx * 4 + sIdx;
      const col = iIdx % 3;
      const row = Math.floor(iIdx / 3);
      const ix = unit.x + 14 + col * 37;
      const iy = 45 + row * 31;

      if (slotNumber < filledSlots) {
        if (unit.kind === 'bottles') {
          // 6-pack glossy bottle caps!
          roundRect(ctx, ix, iy, 27, 19, 5);
          ctx.fillStyle = '#e0f2fe';
          ctx.fill();
          for (let b = 0; b < 3; b++) {
            ctx.beginPath();
            ctx.arc(ix + 6 + b * 7.5, iy + 6, 3.2, 0, Math.PI * 2);
            ctx.arc(ix + 6 + b * 7.5, iy + 13.5, 3.2, 0, Math.PI * 2);
            ctx.fillStyle = itemColor;
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.beginPath();
            ctx.arc(ix + 5 + b * 7.5, iy + 5, 1.1, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (unit.kind === 'bags') {
          // Playful tilted snack bags
          ctx.save();
          ctx.translate(ix + 13, iy + 9);
          ctx.rotate(iIdx % 2 === 0 ? -0.07 : 0.07);
          roundRect(ctx, -13, -9, 26, 18, 6);
          ctx.fillStyle = itemColor;
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          roundRect(ctx, -8, -4, 16, 7, 3);
          ctx.fill();
          ctx.restore();
        } else if (unit.kind === 'fridge') {
          // Cold milk cartons & yogurt packs
          roundRect(ctx, ix + 1, iy, 25, 19, 4);
          ctx.fillStyle = itemColor;
          ctx.fill();
          ctx.strokeStyle = 'rgba(3, 105, 161, 0.25)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.fillStyle = '#0284c7';
          ctx.fillRect(ix + 4, iy + 3, 19, 3.5);
        } else {
          // Cereal / abarrotes boxes with labels
          roundRect(ctx, ix, iy, 27, 19, 4);
          ctx.fillStyle = itemColor;
          ctx.fill();
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.16)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          roundRect(ctx, ix + 3, iy + 3, 21, 5, 2);
          ctx.fill();
        }
      } else {
        // Subtle empty-shelf ghost outline so empty spaces look clear
        roundRect(ctx, ix + 2, iy + 2, 23, 15, 4);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // Glass shine streak on refrigerator
    if (unit.kind === 'fridge') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.beginPath();
      ctx.moveTo(unit.x + 14, 39);
      ctx.lineTo(unit.x + 32, 39);
      ctx.lineTo(unit.x + 14, 103);
      ctx.lineTo(unit.x + 5, 103);
      ctx.closePath();
      ctx.fill();
    }

    // Shelf label
    ctx.fillStyle = '#334155';
    ctx.font = '800 11px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(unit.label, unit.x + 64, 128);
  });

  if (lowStock) {
    roundRect(ctx, 260, 11, 162, 23, 11);
    ctx.fillStyle = '#dc2626';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 11px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('📦 ¡RELLENAR ANAQUELES!', 341, 26);
  }

  // 3. Supplier Receiving Dock (Right side)
  const supActive = state.supplier.active;
  roundRect(ctx, 666, 76, 118, 154, 15);
  ctx.fillStyle = supActive ? `rgba(254, 243, 199, ${0.76 + pulse * 0.24})` : '#f1f5f9';
  ctx.fill();
  ctx.strokeStyle = supActive ? '#f59e0b' : '#cbd5e1';
  ctx.lineWidth = supActive ? 3 : 1.5;
  ctx.stroke();

  // Dock floor hazard accent strip
  ctx.save();
  roundRect(ctx, 768, 104, 12, 98, 4);
  ctx.fillStyle = supActive ? '#f59e0b' : '#cbd5e1';
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = supActive ? '#b45309' : '#64748b';
  ctx.font = '800 10px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PROVEEDORES', 722, 96);

  if (supActive) {
    // Cute top-down delivery van rear + crates + rep
    roundRect(ctx, 744, 114, 36, 62, 6);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(746, 126, 32, 8);

    // Stacked cardboard crates
    roundRect(ctx, 712, 122, 26, 22, 4);
    ctx.fillStyle = '#b45309';
    ctx.fill();
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(722, 122, 5, 22);

    roundRect(ctx, 716, 146, 24, 20, 4);
    ctx.fillStyle = '#d97706';
    ctx.fill();
    ctx.fillStyle = '#fef3c7';
    ctx.fillRect(725, 146, 5, 20);

    // Pulsing delivery rep
    ctx.beginPath();
    ctx.arc(704, 174, 14 + pulse * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(704, 174, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#ea580c';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(704, 172, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#fde68a';
    ctx.fill();

    // Countdown / receiving progress bar
    const ratio = clamp01(state.supplier.timeLeft / state.supplier.maxTime);
    ctx.fillStyle = '#92400e';
    ctx.font = '800 10.5px "DM Sans", system-ui, sans-serif';
    ctx.fillText(
      state.supplier.progress > 0
        ? 'Recibiendo…'
        : `${Math.ceil(state.supplier.timeLeft)}s · ¡Toca!`,
      722,
      204,
    );

    roundRect(ctx, 680, 211, 88, 9, 4.5);
    ctx.fillStyle = '#fde68a';
    ctx.fill();
    roundRect(
      ctx,
      680,
      211,
      88 * (state.supplier.progress > 0 ? state.supplier.progress : ratio),
      9,
      4.5,
    );
    ctx.fillStyle = state.supplier.progress > 0 ? '#10b981' : '#f59e0b';
    ctx.fill();
  } else {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 10px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Puerta cerrada', 722, 156);
  }

  // 4. Floor Messes (Glossy spills, footprints, wrappers + soap bubbles when scrubbing!)
  for (const m of state.messes) {
    ctx.save();
    ctx.translate(m.x, m.y);
    const shrink = 1 - m.progress * 0.55;
    ctx.scale(shrink, shrink);
    if (m.kind === 'spill') {
      ctx.fillStyle = `${m.color}d8`;
      ctx.beginPath();
      ctx.ellipse(0, 0, m.size, m.size * 0.72, 0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(m.size * 0.75, -m.size * 0.3, m.size * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-m.size * 0.65, m.size * 0.45, m.size * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(
        -m.size * 0.28,
        -m.size * 0.2,
        m.size * 0.32,
        m.size * 0.16,
        -0.3,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else if (m.kind === 'tracks') {
      ctx.fillStyle = '#78716cd8';
      ctx.beginPath();
      ctx.ellipse(-7, -4, 6.5, 3.8, 0.4, 0, Math.PI * 2);
      ctx.ellipse(7, 4, 6.5, 3.8, 0.4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = m.color;
      roundRect(ctx, -9, -6, 18, 12, 3);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();

    // Animated soap bubbles + progress ring while cleaning
    if (m.progress > 0) {
      ctx.beginPath();
      ctx.arc(m.x, m.y, 19, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * m.progress);
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 3.5;
      ctx.stroke();

      for (let b = 0; b < 3; b++) {
        const ang = state.elapsed * 5 + b * 2.1;
        const bx = m.x + Math.cos(ang) * 14;
        const by = m.y + Math.sin(ang) * 12;
        ctx.beginPath();
        ctx.arc(bx, by, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(186, 230, 253, 0.85)';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // 5. Illustrated Checkout Counters (3 Cajas)
  REGISTER_XS.forEach((rx, idx) => {
    const cashier = getCashierAtRegister(state, idx);
    const active = !!cashier && !cashier.moving;
    const queue = getRegisterQueue(state, idx);
    const queueCount = queue.length;
    const scanning = active && queueCount > 0 && queue[0].checkoutProgress > 0;

    // Queue lane carpet
    roundRect(ctx, rx - 31, 214, 62, 152, 14);
    ctx.fillStyle = active ? 'rgba(16, 185, 129, 0.085)' : 'rgba(148, 163, 184, 0.09)';
    ctx.fill();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = active ? 'rgba(16, 185, 129, 0.36)' : '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Counter drop shadow
    roundRect(ctx, rx - 66, COUNTER_Y - 15, 134, 42, 11);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.11)';
    ctx.fill();

    // Counter body
    roundRect(ctx, rx - 68, COUNTER_Y - 20, 136, 40, 11);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = active ? accentColor : queueCount > 0 ? '#f59e0b' : '#cbd5e1';
    ctx.lineWidth = active || queueCount > 0 ? 2.5 : 1.5;
    ctx.stroke();

    // Conveyor belt (animated stripes when scanning!)
    roundRect(ctx, rx - 58, COUNTER_Y - 12, 54, 24, 5);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    const beltShift = scanning ? (state.elapsed * 32) % 12 : 0;
    ctx.save();
    roundRect(ctx, rx - 58, COUNTER_Y - 12, 54, 24, 5);
    ctx.clip();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    for (let bx = rx - 58 + beltShift; bx < rx - 2; bx += 12) {
      ctx.beginPath();
      ctx.moveTo(bx, COUNTER_Y - 12);
      ctx.lineTo(bx, COUNTER_Y + 12);
      ctx.stroke();
    }
    // Red barcode scanner laser beam & item on belt when scanning!
    if (scanning) {
      roundRect(ctx, rx - 38, COUNTER_Y - 6, 14, 12, 3);
      ctx.fillStyle = '#f97316';
      ctx.fill();
      if (Math.sin(state.elapsed * 22) > -0.2) {
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(rx - 31, COUNTER_Y - 12);
        ctx.lineTo(rx - 31, COUNTER_Y + 12);
        ctx.stroke();
      }
    }
    ctx.restore();

    // POS Monitor & cash drawer
    roundRect(ctx, rx + 8, COUNTER_Y - 13, 28, 22, 4);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    roundRect(ctx, rx + 12, COUNTER_Y - 9, 20, 12, 2);
    ctx.fillStyle = scanning ? '#6ee7b7' : active ? '#34d399' : '#64748b';
    ctx.fill();

    // Status LED
    ctx.beginPath();
    ctx.arc(rx + 52, COUNTER_Y - 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#10b981' : queueCount > 0 ? '#f59e0b' : '#94a3b8';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx + 50, COUNTER_Y - 4, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fill();

    // Caja label pill cleanly mounted on the bottom edge of the counter
    roundRect(ctx, rx - 28, COUNTER_Y + 11, 56, 17, 8);
    ctx.fillStyle = active ? accentColor : '#475569';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 10.5px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Caja ${idx + 1}`, rx, COUNTER_Y + 23);

    // Unattended alert pill when customers wait with no cashier
    if (!cashier && queueCount > 0) {
      roundRect(ctx, rx - 46, COUNTER_Y + 34, 92, 19, 9.5);
      ctx.fillStyle = `rgba(245, 158, 11, ${0.84 + pulse * 0.16})`;
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 10px "DM Sans", system-ui, sans-serif';
      ctx.fillText('¡Sin cajero!', rx, COUNTER_Y + 47);
    }
  });

  // 6. Expressive Customers
  for (const cust of state.customers) {
    const pRatio = clamp01(cust.patience / cust.maxPatience);
    const shaking =
      cust.state === 'queueing' && pRatio < 0.28 ? Math.sin(state.elapsed * 38 + cust.id) * 1.8 : 0;
    const walkBob =
      cust.state === 'browsing' || cust.state === 'leaving_happy' || cust.state === 'leaving_angry'
        ? Math.sin(state.elapsed * 12 + cust.id) * 1.5
        : 0;

    ctx.save();
    ctx.translate(cust.x + shaking, cust.y + walkBob);

    // Shopping cart prop for 'cart' customer
    if (cust.kind === 'cart') {
      roundRect(ctx, -13, 13, 26, 16, 4);
      ctx.fillStyle = '#e2e8f0';
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = '#f97316';
      ctx.fillRect(-9, 16, 8, 6);
      ctx.fillStyle = '#10b981';
      ctx.fillRect(1, 16, 8, 6);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(-4, 21, 9, 5);
    } else if (cust.kind === 'normal' && cust.state === 'queueing') {
      // Cute hand basket
      roundRect(ctx, 12, 3, 11, 9, 2.5);
      ctx.fillStyle = '#10b981';
      ctx.fill();
      ctx.strokeStyle = '#065f46';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Shadow
    ctx.beginPath();
    ctx.ellipse(0, 6, 15, 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
    ctx.fill();

    // Shoulders / shirt
    ctx.beginPath();
    ctx.ellipse(0, 1, 15.5, 11.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = cust.shirtColor;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Head
    ctx.beginPath();
    ctx.arc(0, -1, 8.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fed7aa';
    ctx.fill();

    // Varied hair
    const hair = cust.kind === 'rushed' ? '#7f1d1d' : HAIR_PALETTE[cust.id % HAIR_PALETTE.length];
    ctx.beginPath();
    ctx.arc(0, -3.5, 7.5, Math.PI, Math.PI * 2);
    ctx.fillStyle = hair;
    ctx.fill();

    // Archetype mini-badge
    if (cust.kind === 'rushed') {
      ctx.font = '700 12px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚡', 16, -6);
    } else if (cust.kind === 'messy') {
      ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('💧', 16, -6);
    }

    // Patience bar + reason badge when queueing
    if (cust.state === 'queueing') {
      roundRect(ctx, -19, -23, 38, 6.5, 3.25);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.25)';
      ctx.fill();
      roundRect(ctx, -19, -23, 38 * pRatio, 6.5, 3.25);
      ctx.fillStyle = pRatio > 0.5 ? '#10b981' : pRatio > 0.25 ? '#f59e0b' : '#ef4444';
      ctx.fill();

      // Show why customer is getting impatient
      if (pRatio < 0.65 && (state.stock < 35 || state.cleanliness < 40)) {
        ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(state.stock < 35 ? '📦' : '🧹', -24, -14);
      }

      // Active checkout scan bar
      if (cust.checkoutProgress > 0) {
        roundRect(ctx, -19, 16, 38, 5.5, 2.75);
        ctx.fillStyle = '#e2e8f0';
        ctx.fill();
        roundRect(ctx, -19, 16, 38 * clamp01(cust.checkoutProgress), 5.5, 2.75);
        ctx.fillStyle = accentColor;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // 7. Illustrated Cashiers (Sofía, Mateo, Valeria)
  for (const c of state.cashiers) {
    // Dashed destination line while walking
    if (c.moving && state.status === 'playing') {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = `${c.color}88`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.targetX, c.targetY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(c.targetX, c.targetY, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = `${c.color}66`;
      ctx.fill();
      ctx.restore();
    }

    const selected = state.selectedCashier === c.id && state.status === 'playing';
    const bob = c.moving ? Math.sin(c.workAnim) * 2.5 : 0;

    ctx.save();
    ctx.translate(c.x, c.y + bob);

    // Selection glow halo
    if (selected) {
      ctx.beginPath();
      ctx.arc(0, 0, 25 + pulse * 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = `${c.color}20`;
      ctx.fill();
    }

    // Animated task prop
    if (c.task === 'clean') {
      const swing = Math.sin(c.workAnim * 1.8) * 0.48;
      ctx.save();
      ctx.rotate(swing);
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(10, 4);
      ctx.lineTo(25, -15);
      ctx.stroke();
      roundRect(ctx, 18, -22, 15, 9, 4.5);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
      ctx.restore();
    } else if (c.task === 'restock') {
      roundRect(ctx, -12, -25, 24, 15, 3.5);
      ctx.fillStyle = '#d97706';
      ctx.fill();
      ctx.fillStyle = '#fef3c7';
      ctx.fillRect(-2, -25, 4, 15);
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else if (c.task === 'supplier') {
      roundRect(ctx, 13, -10, 12, 16, 2.5);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(16, -12, 6, 3.5);
    }

    // Shadow
    ctx.beginPath();
    ctx.ellipse(0, 7, 17, 11, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.16)';
    ctx.fill();

    // Uniform shoulders
    ctx.beginPath();
    ctx.ellipse(0, 1, 17.5, 13.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Apron / vest accent
    ctx.beginPath();
    ctx.arc(0, 4, 9.5, 0, Math.PI);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.fill();

    // Head
    ctx.beginPath();
    ctx.arc(0, -2, 9.2, 0, Math.PI * 2);
    ctx.fillStyle = '#fde68a';
    ctx.fill();

    // Distinct cashier hair / cap
    ctx.beginPath();
    ctx.arc(0, -4.5, 8.2, Math.PI, Math.PI * 2);
    ctx.fillStyle = c.id === 1 ? '#451a03' : '#1e293b';
    ctx.fill();
    if (c.id === 0) {
      // Sofía's visor accent
      roundRect(ctx, -7, -11, 14, 3.5, 2);
      ctx.fillStyle = '#14b8a6';
      ctx.fill();
    } else if (c.id === 2) {
      // Valeria's hair bun
      ctx.beginPath();
      ctx.arc(0, -12, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#1e293b';
      ctx.fill();
    }

    // Name pill
    roundRect(ctx, -25, 15, 50, 17, 8.5);
    ctx.fillStyle = selected ? c.color : '#0f172a';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 10px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(c.name, 0, 26.5);

    ctx.restore();
  }

  // 8. Sparkles & Confetti particles
  for (const sp of state.sparkles) {
    const alpha = clamp01(sp.life / sp.maxLife);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = sp.color;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, sp.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 9. Floating score/feedback popups
  for (const ft of state.floatingTexts) {
    const alpha = clamp01(ft.life / ft.maxLife);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '800 13.5px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeText(ft.text, ft.x, ft.y);
    ctx.fillStyle = ft.color;
    ctx.fillText(ft.text, ft.x, ft.y);
    ctx.restore();
  }

  // 10. Rush hour warm glow frame
  if (state.rushTimeLeft > 0) {
    ctx.strokeStyle = `rgba(249, 115, 22, ${0.38 + pulse * 0.45})`;
    ctx.lineWidth = 9;
    ctx.strokeRect(4.5, 4.5, WORLD_W - 9, WORLD_H - 9);
  }
}

export default function Minigame({
  user,
  branchId,
  branchName,
  online,
}: {
  user: User;
  branchId: string;
  branchName: string;
  online: boolean;
}) {
  const [selectedMode, setSelectedMode] = useState<GameMode>('shift');
  const [shiftPeriod, setShiftPeriod] = useState<ShiftPeriod>('morning');
  const [boardMode, setBoardMode] = useState<GameMode>('shift');
  const [muted, setMuted] = useState(false);

  const gameRef = useRef<GameState>(createInitialState('shift', 'morning', 'idle'));
  const [hud, setHud] = useState<HudSnapshot>(() => snapshotHud(gameRef.current));

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const soundRef = useRef<SoundPlayer | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const [board, setBoard] = useState<BoardResponse | null>(() =>
    branchId ? readCachedBoard(branchId, 'shift') : null,
  );
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState('');
  const [saveState, setSaveState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved'; personalBest: boolean; branchRecord: boolean; rank: number | null }
    | { kind: 'offline' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const submittedMatchRef = useRef<string>('');

  const loadBoard = useCallback(
    async (mode: GameMode) => {
      if (!branchId) return;
      const cached = readCachedBoard(branchId, mode);
      if (cached) setBoard(cached);
      if (!online || !hasOnlineSession()) return;
      setBoardLoading(true);
      setBoardError('');
      try {
        const res = (await request(
          `/minigame/leaderboard?branch_id=${encodeURIComponent(branchId)}&mode=${mode}`,
        )) as BoardResponse;
        setBoard(res);
        writeCachedBoard(branchId, mode, res);
      } catch (err) {
        setBoardError((err as Error).message || 'No se pudo cargar la tabla de puntuaciones.');
      } finally {
        setBoardLoading(false);
      }
    },
    [branchId, online],
  );

  // Flush any offline-queued scores when back online
  useEffect(() => {
    if (!branchId || !online || !hasOnlineSession()) return;
    const queued = readQueuedScores();
    const mine = queued.filter((q) => q.branch_id === branchId);
    if (!mine.length) return;
    let cancelled = false;
    (async () => {
      const remaining = [...queued];
      for (const item of mine) {
        try {
          await request('/minigame/scores', item);
          const idx = remaining.findIndex((r) => r.id === item.id);
          if (idx >= 0) remaining.splice(idx, 1);
        } catch {
          break;
        }
      }
      writeQueuedScores(remaining);
      if (!cancelled) loadBoard(boardMode);
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, online, boardMode, loadBoard]);

  useEffect(() => {
    loadBoard(boardMode);
  }, [boardMode, loadBoard]);

  const submitScore = useCallback(
    async (finished: GameState) => {
      if (!branchId) return;
      if (submittedMatchRef.current === finished.matchId) return;
      submittedMatchRef.current = finished.matchId;

      const payload: QueuedScore = {
        branch_id: branchId,
        id: finished.matchId,
        mode: finished.mode,
        score: finished.score,
        customers_served: finished.customersServed,
        sales_cents: finished.salesCents,
        grade: finished.grade,
        duration_seconds: Math.max(1, Math.round(finished.elapsed)),
        max_combo: finished.maxCombo,
        suppliers_received: finished.suppliersReceived,
      };

      setBoardMode(finished.mode);

      if (!online || !hasOnlineSession()) {
        const current = readQueuedScores();
        if (!current.some((item) => item.id === payload.id)) {
          writeQueuedScores([...current, payload]);
        }
        setSaveState({ kind: 'offline' });
        return;
      }

      setSaveState({ kind: 'saving' });
      try {
        const res = await request('/minigame/scores', payload);
        setBoard(res);
        writeCachedBoard(branchId, finished.mode, res);
        setSaveState({
          kind: 'saved',
          personalBest: !!res.is_personal_best,
          branchRecord: !!res.is_branch_record,
          rank: res.personal?.rank ?? null,
        });
      } catch (err) {
        const current = readQueuedScores();
        if (!current.some((item) => item.id === payload.id)) {
          writeQueuedScores([...current, payload]);
        }
        setSaveState({
          kind: 'error',
          message: (err as Error).message || 'Se guardó localmente para enviarlo al reconectar.',
        });
      }
    },
    [branchId, online],
  );

  // Main 60fps loop
  useEffect(() => {
    let rafId = 0;
    let lastTs = performance.now();
    let hudTimer = 0;

    const renderFrame = (ts: number) => {
      const dt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
      lastTs = ts;

      const state = gameRef.current;
      const prevStatus = state.status;
      if (state.status === 'playing') {
        stepGame(state, dt);
      }

      if (state.soundQueue.length > 0) {
        const cues = state.soundQueue.splice(0, state.soundQueue.length);
        if (!mutedRef.current) {
          if (!soundRef.current) soundRef.current = new SoundPlayer();
          for (const cue of cues) soundRef.current.play(cue);
        }
      }

      if (prevStatus === 'playing' && state.status === 'finished') {
        setHud(snapshotHud(state));
        submitScore(state);
      } else {
        hudTimer += dt;
        if (hudTimer >= 0.08) {
          hudTimer = 0;
          setHud(snapshotHud(state));
        }
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetW = WORLD_W * dpr;
        const targetH = WORLD_H * dpr;
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);
          const accent =
            getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() ||
            '#059669';
          drawStore(ctx, state, accent);
          ctx.restore();
        }
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [submitScore]);

  const startGame = useCallback(
    (mode: GameMode = selectedMode, period: ShiftPeriod = shiftPeriod) => {
      setSelectedMode(mode);
      setShiftPeriod(period);
      setBoardMode(mode);
      setSaveState({ kind: 'idle' });
      const fresh = createInitialState(mode, period, 'playing');
      gameRef.current = fresh;
      setHud(snapshotHud(fresh));
    },
    [selectedMode, shiftPeriod],
  );

  const togglePause = useCallback(() => {
    const s = gameRef.current;
    if (s.status === 'playing') {
      s.status = 'paused';
      setHud(snapshotHud(s));
    } else if (s.status === 'paused') {
      s.status = 'playing';
      setHud(snapshotHud(s));
    }
  }, []);

  const selectCashier = useCallback((id: number) => {
    gameRef.current.selectedCashier = id;
    setHud(snapshotHud(gameRef.current));
  }, []);

  const sendCashier = useCallback((cashierId: number, task: CashierTaskKind) => {
    gameRef.current.selectedCashier = cashierId;
    assignCashierTask(gameRef.current, cashierId, task);
    setHud(snapshotHud(gameRef.current));
  }, []);

  // Keyboard shortcuts for desktop players
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const state = gameRef.current;
      if (e.code === 'Space' && (state.status === 'playing' || state.status === 'paused')) {
        e.preventDefault();
        togglePause();
        return;
      }
      if (state.status !== 'playing') return;
      if (e.key === '1') selectCashier(0);
      else if (e.key === '2') selectCashier(1);
      else if (e.key === '3') selectCashier(2);
      else if (e.key.toLowerCase() === 'q') sendCashier(state.selectedCashier, 'register');
      else if (e.key.toLowerCase() === 'w') sendCashier(state.selectedCashier, 'restock');
      else if (e.key.toLowerCase() === 'e') sendCashier(state.selectedCashier, 'clean');
      else if (e.key.toLowerCase() === 'r' && state.supplier.active)
        sendCashier(state.selectedCashier, 'supplier');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectCashier, sendCashier, togglePause]);

  function onCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WORLD_W;
    const y = ((e.clientY - rect.top) / rect.height) * WORLD_H;
    if (handleCanvasClick(gameRef.current, x, y)) {
      setHud(snapshotHud(gameRef.current));
    }
  }

  const taskSummary = (c: HudSnapshot['cashiers'][number]) => {
    if (c.task === 'register') return `Caja ${c.registerIndex + 1}`;
    if (c.task === 'restock') return 'Rellenando';
    if (c.task === 'clean') return 'Limpiando';
    return 'Proveedor';
  };

  // Next rival motivator on finish screen ("¡Te faltaron solo X pts para superar a Y!")
  const nextRival =
    hud.status === 'finished' && board?.leaderboard?.length
      ? [...board.leaderboard]
          .reverse()
          .find((row) => row.user_id !== user.id && row.score > hud.score)
      : null;

  const activeCashier = hud.cashiers[hud.selectedCashier] ?? hud.cashiers[0];
  const pendingOfflineCount = readQueuedScores().filter((q) => q.branch_id === branchId).length;
  const overlayOpen = hud.status === 'idle' || hud.status === 'finished';

  return (
    <div className="minigame-layout">
      <div className="minigame-stage">
        {/* Compact Arcade HUD bar */}
        <div className={`mg-hud ${hud.rushActive ? 'rush-active' : ''}`}>
          <div className="mg-hud-group">
            {hud.mode === 'shift' ? (
              <div className={`mg-pill ${hud.rushActive ? 'rush' : ''}`}>
                <Clock size={14} />
                <span>
                  <span className="mg-hide-sm">
                    {hud.shiftPeriod === 'morning' ? 'Mañana' : 'Tarde'} {hud.shiftClock} ·{' '}
                  </span>
                  <strong>{formatTimer(hud.timeLeft)}</strong>
                </span>
              </div>
            ) : (
              <div className={`mg-pill ${hud.rushActive ? 'rush' : ''}`}>
                <Flame size={14} />
                <span>
                  <span className="mg-hide-sm">Oleada </span>
                  <strong>O{hud.wave}</strong>
                </span>
                <span className="mg-hearts" aria-label={`${hud.lives} vidas restantes`}>
                  {Array.from({ length: hud.maxLives }, (_, i) => (
                    <Heart
                      key={i}
                      size={13}
                      fill={i < hud.lives ? '#ef4444' : 'none'}
                      color={i < hud.lives ? '#ef4444' : '#cbd5e1'}
                    />
                  ))}
                </span>
              </div>
            )}

            <div
              className={`mg-pill score ${hud.combo >= 3 ? 'hot' : ''}`}
              title="Mantén surtido y limpieza ≥ 60% para subir la racha hasta x5"
            >
              <Trophy size={14} />
              <strong>{hud.score.toLocaleString('es-MX')}</strong>
              <small>pts</small>
              {hud.combo > 1 && <span className="mg-combo">x{hud.combo}</span>}
            </div>

            {hud.rushActive && hud.status === 'playing' && (
              <div className="mg-pill rush">
                <Flame size={13} />
                <strong>Hora Pico {hud.rushSecondsLeft}s</strong>
              </div>
            )}

            <div className="mg-pill subtle mg-hide-sm">
              <span>{money(BigInt(hud.salesCents))}</span>
            </div>
          </div>

          <div className="mg-meters">
            <div className={`mg-meter ${hud.stock < 35 ? 'danger' : ''}`}>
              <div className="mg-meter-label">
                <Package size={13} />
                <span>Surtido</span>
                <strong>{hud.stock}%</strong>
              </div>
              <div className="mg-meter-track">
                <div className="mg-meter-fill stock" style={{ width: `${hud.stock}%` }} />
              </div>
            </div>

            <div
              className={`mg-meter ${hud.cleanliness < 40 || hud.messCount >= 4 ? 'danger' : ''}`}
            >
              <div className="mg-meter-label">
                <Sparkles size={13} />
                <span>Limpieza</span>
                <strong>
                  {hud.cleanliness}%{hud.messCount > 0 ? ` (${hud.messCount})` : ''}
                </strong>
              </div>
              <div className="mg-meter-track">
                <div className="mg-meter-fill clean" style={{ width: `${hud.cleanliness}%` }} />
              </div>
            </div>
          </div>

          <div className="mg-hud-actions">
            <button
              type="button"
              className="secondary mg-icon-btn"
              title={muted ? 'Activar sonido' : 'Silenciar sonido'}
              aria-label={muted ? 'Activar sonido' : 'Silenciar sonido'}
              onClick={() => setMuted((m) => !m)}
            >
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            {(hud.status === 'playing' || hud.status === 'paused') && (
              <>
                <button
                  type="button"
                  className="secondary mg-icon-btn"
                  title={hud.status === 'paused' ? 'Reanudar (Espacio)' : 'Pausar (Espacio)'}
                  aria-label={hud.status === 'paused' ? 'Reanudar' : 'Pausar'}
                  onClick={togglePause}
                >
                  {hud.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}
                </button>
                <button
                  type="button"
                  className="secondary mg-icon-btn"
                  title="Reiniciar partida"
                  aria-label="Reiniciar partida"
                  onClick={() => startGame(hud.mode, hud.shiftPeriod)}
                >
                  <RotateCcw size={15} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Aerial Store Canvas + Smart Mobile Overlays */}
        <div className={`mg-canvas-wrap ${overlayOpen ? 'has-overlay' : ''}`}>
          <canvas
            ref={canvasRef}
            className="mg-canvas"
            onPointerDown={onCanvasPointerDown}
            aria-label="Mapa aéreo de la tienda Hora Pico"
          />

          {hud.banner && hud.status === 'playing' && (
            <div className={`mg-banner ${hud.banner.tone}`}>{hud.banner.text}</div>
          )}

          {/* Start Screen Overlay — simple, juicy, 3-second understanding */}
          {hud.status === 'idle' && (
            <div className="mg-overlay">
              <div className="mg-overlay-card">
                <div className="mg-title-row">
                  <div className="mg-title-icon">
                    <Gamepad2 size={24} />
                  </div>
                  <div>
                    <h2>Hora Pico en Mostrador</h2>
                    <p>¡Atiende a todos antes de que se vacíe o ensucie la tienda!</p>
                  </div>
                </div>

                <div className="mg-howto">
                  <div>
                    <strong>1. Elige cajero</strong>
                    <span>Sofía 🏪 · Mateo 📦 · Valeria 🧹</span>
                  </div>
                  <div>
                    <strong>2. Mándalo a trabajar</strong>
                    <span>Caja, Rellenar, Limpiar o Proveedor</span>
                  </div>
                  <div>
                    <strong>3. Mantén la racha</strong>
                    <span>Surtido y limpieza ≥ 60% dan hasta x5</span>
                  </div>
                </div>

                <div className="mg-mode-grid">
                  <button
                    type="button"
                    className={`mg-mode-card ${selectedMode === 'shift' ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedMode('shift');
                      setBoardMode('shift');
                    }}
                  >
                    <div className="mg-mode-head">
                      <Clock size={17} />
                      <strong>Turno Completo</strong>
                    </div>
                    <small>2 min 30 s · Saca nota S en tu corte.</small>
                  </button>
                  <button
                    type="button"
                    className={`mg-mode-card ${selectedMode === 'endless' ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedMode('endless');
                      setBoardMode('endless');
                    }}
                  >
                    <div className="mg-mode-head">
                      <Flame size={17} />
                      <strong>Hora Pico Infinita</strong>
                    </div>
                    <small>5 vidas · Oleadas sin fin por el #1.</small>
                  </button>
                </div>

                {selectedMode === 'shift' && (
                  <div className="mg-shift-toggle">
                    <span>Turno:</span>
                    <button
                      type="button"
                      className={shiftPeriod === 'morning' ? 'selected' : 'secondary'}
                      onClick={() => setShiftPeriod('morning')}
                    >
                      ☀️ Mañana
                    </button>
                    <button
                      type="button"
                      className={shiftPeriod === 'afternoon' ? 'selected' : 'secondary'}
                      onClick={() => setShiftPeriod('afternoon')}
                    >
                      🌙 Tarde
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  className="primary mg-start-btn"
                  onClick={() => startGame(selectedMode, shiftPeriod)}
                >
                  <Play size={18} />
                  ¡Abrir la tienda!
                </button>
              </div>
            </div>
          )}

          {/* Pause Overlay */}
          {hud.status === 'paused' && (
            <div className="mg-overlay">
              <div className="mg-overlay-card compact">
                <h3>Turno en pausa</h3>
                <p>Atiende el mostrador real con calma; tu partida sigue donde quedó.</p>
                <div className="mg-overlay-actions">
                  <button type="button" className="primary" onClick={togglePause}>
                    <Play size={16} />
                    Continuar
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => startGame(hud.mode, hud.shiftPeriod)}
                  >
                    <RotateCcw size={16} />
                    Reiniciar
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Finished / Corte del Turno Overlay */}
          {hud.status === 'finished' && (
            <div className="mg-overlay">
              <div className="mg-overlay-card">
                <div className="mg-finish-head">
                  <div className={`mg-grade grade-${hud.grade.toLowerCase()}`}>{hud.grade}</div>
                  <div>
                    <p className="mg-finish-kicker">
                      {hud.mode === 'shift'
                        ? 'Corte del turno'
                        : `Fin de Hora Pico · Oleada ${hud.wave}`}
                    </p>
                    <h3>{hud.score.toLocaleString('es-MX')} puntos</h3>
                    <div className="mg-badges-row">
                      {saveState.kind === 'saved' && saveState.branchRecord && (
                        <span className="mg-record-badge crown">
                          <Crown size={13} /> ¡#1 de {branchName || 'la sucursal'}!
                        </span>
                      )}
                      {saveState.kind === 'saved' &&
                        saveState.personalBest &&
                        !saveState.branchRecord && (
                          <span className="mg-record-badge best">
                            <Award size={13} /> ¡Nuevo récord personal!
                          </span>
                        )}
                      {saveState.kind === 'saved' && saveState.rank && (
                        <span className="mg-record-badge neutral">
                          Puesto #{saveState.rank} en la sucursal
                        </span>
                      )}
                      {saveState.kind === 'saving' && (
                        <span className="mg-record-badge neutral">Guardando puntaje…</span>
                      )}
                      {saveState.kind === 'offline' && (
                        <span className="mg-record-badge warn">
                          <WifiOff size={13} /> Guardado local; se subirá al conectar.
                        </span>
                      )}
                      {saveState.kind === 'error' && (
                        <span className="mg-record-badge warn">{saveState.message}</span>
                      )}
                    </div>
                  </div>
                </div>

                {nextRival && (
                  <div className="mg-rival-banner">
                    <Flame size={15} />
                    <span>
                      ¡Te faltaron solo{' '}
                      <strong>{(nextRival.score - hud.score).toLocaleString('es-MX')} pts</strong>{' '}
                      para superar a <strong>{nextRival.user_name}</strong> (#{nextRival.rank})!
                    </span>
                  </div>
                )}

                <div className="mg-summary-grid">
                  <div>
                    <span>Atendidos</span>
                    <strong>{hud.customersServed}</strong>
                  </div>
                  <div>
                    <span>Perdidos</span>
                    <strong>{hud.customersLost}</strong>
                  </div>
                  <div>
                    <span>Venta</span>
                    <strong>{money(BigInt(hud.salesCents))}</strong>
                  </div>
                  <div>
                    <span>Racha máx.</span>
                    <strong>x{hud.maxCombo}</strong>
                  </div>
                  <div>
                    <span>Limpiezas</span>
                    <strong>{hud.messesCleaned}</strong>
                  </div>
                  <div>
                    <span>Proveedores</span>
                    <strong>{hud.suppliersReceived}</strong>
                  </div>
                </div>

                <div className="mg-overlay-actions">
                  <button
                    type="button"
                    className="primary mg-replay-btn"
                    onClick={() => startGame(hud.mode, hud.shiftPeriod)}
                  >
                    <RotateCcw size={16} />
                    ¡Jugar otra vez!
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      const nextMode: GameMode = hud.mode === 'shift' ? 'endless' : 'shift';
                      setSelectedMode(nextMode);
                      setBoardMode(nextMode);
                      gameRef.current = createInitialState(nextMode, shiftPeriod, 'idle');
                      setHud(snapshotHud(gameRef.current));
                    }}
                  >
                    Probar {hud.mode === 'shift' ? 'Infinito' : 'Turno'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* MOBILE THUMB ARCADE PAD — zero scrolling, big tactile buttons */}
        {(hud.status === 'playing' || hud.status === 'paused') && (
          <div className="mg-mobile-pad" aria-label="Controles táctiles">
            {hud.supplierActive && hud.status === 'playing' && (
              <button
                type="button"
                className="mg-mobile-supplier"
                onClick={() => sendCashier(activeCashier.id, 'supplier')}
              >
                <Truck size={16} />
                <span>
                  ¡Llegó proveedor! Toca para recibir con {activeCashier.name} (
                  {hud.supplierTimeLeft}
                  s)
                </span>
              </button>
            )}

            <div className="mg-mobile-cashiers">
              {hud.cashiers.map((c) => {
                const isSelected = hud.selectedCashier === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`mg-m-cashier ${isSelected ? 'selected' : ''}`}
                    style={isSelected ? { borderColor: c.color } : undefined}
                    onClick={() => selectCashier(c.id)}
                  >
                    <span className="mg-m-cashier-top">
                      <span className="mg-cashier-dot" style={{ background: c.color }} />
                      <strong>{c.name}</strong>
                      <span>{SPECIALTY_EMOJI[c.specialty]}</span>
                    </span>
                    <small>{taskSummary(c)}</small>
                  </button>
                );
              })}
            </div>

            <div className="mg-mobile-actions">
              <button
                type="button"
                className={`mg-m-action ${activeCashier.task === 'register' ? 'active' : ''}`}
                disabled={hud.status !== 'playing'}
                onClick={() => sendCashier(activeCashier.id, 'register')}
              >
                <Store size={17} />
                <span>Caja</span>
              </button>
              <button
                type="button"
                className={`mg-m-action ${activeCashier.task === 'restock' ? 'active' : ''} ${
                  hud.stock < 35 ? 'urgent' : ''
                }`}
                disabled={hud.status !== 'playing'}
                onClick={() => sendCashier(activeCashier.id, 'restock')}
              >
                <Package size={17} />
                <span>Rellenar</span>
              </button>
              <button
                type="button"
                className={`mg-m-action ${activeCashier.task === 'clean' ? 'active' : ''} ${
                  hud.cleanliness < 40 || hud.messCount >= 4 ? 'urgent' : ''
                }`}
                disabled={hud.status !== 'playing'}
                onClick={() => sendCashier(activeCashier.id, 'clean')}
              >
                <Sparkles size={17} />
                <span>Limpiar</span>
              </button>
            </div>
          </div>
        )}

        {/* DESKTOP 3-COLUMN CASHIER DOCK */}
        <div className="mg-dock">
          {hud.cashiers.map((c, idx) => {
            const isSelected = hud.selectedCashier === c.id;
            return (
              <div
                key={c.id}
                className={`mg-cashier-card ${isSelected ? 'selected' : ''}`}
                onClick={() => selectCashier(c.id)}
              >
                <div className="mg-cashier-head">
                  <span className="mg-cashier-dot" style={{ background: c.color }} />
                  <div className="mg-cashier-meta">
                    <strong>
                      {idx + 1}. {c.name} {SPECIALTY_EMOJI[c.specialty]}
                    </strong>
                    <small>{SPECIALTY_LABELS[c.specialty]}</small>
                  </div>
                  <span className="mg-cashier-state">{taskSummary(c)}</span>
                </div>
                <div className="mg-cashier-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className={`mg-task-btn ${c.task === 'register' ? 'active' : ''}`}
                    disabled={hud.status !== 'playing'}
                    onClick={() => sendCashier(c.id, 'register')}
                  >
                    <Store size={14} /> Caja
                  </button>
                  <button
                    type="button"
                    className={`mg-task-btn ${c.task === 'restock' ? 'active' : ''} ${
                      hud.stock < 35 ? 'urgent' : ''
                    }`}
                    disabled={hud.status !== 'playing'}
                    onClick={() => sendCashier(c.id, 'restock')}
                  >
                    <Package size={14} /> Rellenar
                  </button>
                  <button
                    type="button"
                    className={`mg-task-btn ${c.task === 'clean' ? 'active' : ''} ${
                      hud.cleanliness < 40 || hud.messCount >= 4 ? 'urgent' : ''
                    }`}
                    disabled={hud.status !== 'playing'}
                    onClick={() => sendCashier(c.id, 'clean')}
                  >
                    <Sparkles size={14} /> Limpiar
                  </button>
                  {hud.supplierActive && (
                    <button
                      type="button"
                      className={`mg-task-btn supplier ${c.task === 'supplier' ? 'active' : ''}`}
                      disabled={hud.status !== 'playing'}
                      onClick={() => sendCashier(c.id, 'supplier')}
                    >
                      <Truck size={14} /> Recibir ({hud.supplierTimeLeft}s)
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mg-shortcut-hint">
          También puedes tocar directo una caja, los anaqueles, una mancha o la puerta de
          proveedores en el mapa. En PC: <strong>1-2-3</strong> cajero · <strong>Q/W/E/R</strong>{' '}
          acción · <strong>Espacio</strong> pausa.
        </p>
      </div>

      {/* Branch Leaderboard Sidebar */}
      <aside className="mg-leaderboard-card">
        <div className="mg-lb-head">
          <div>
            <h3>
              <Trophy size={18} /> Récords de {branchName || 'la sucursal'}
            </h3>
            <p>Compite con todo el equipo: empleados y administradores.</p>
          </div>
          <button
            type="button"
            className="secondary mg-icon-btn"
            title="Actualizar tabla"
            aria-label="Actualizar tabla"
            disabled={boardLoading || !online}
            onClick={() => loadBoard(boardMode)}
          >
            <RefreshCw size={15} className={boardLoading ? 'spin' : ''} />
          </button>
        </div>

        <div className="mg-lb-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={boardMode === 'shift'}
            className={boardMode === 'shift' ? 'active' : ''}
            onClick={() => setBoardMode('shift')}
          >
            <Clock size={14} /> Turno Completo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={boardMode === 'endless'}
            className={boardMode === 'endless' ? 'active' : ''}
            onClick={() => setBoardMode('endless')}
          >
            <Flame size={14} /> Infinito
          </button>
        </div>

        {!branchId && (
          <div className="mg-lb-notice">
            <Store size={14} />
            <span>
              Crea o selecciona una sucursal en <strong>Configuración</strong> para guardar y ver
              los récords del equipo.
            </span>
          </div>
        )}
        {!online && (
          <div className="mg-lb-notice">
            <WifiOff size={14} />
            <span>
              Sin conexión. Mostrando última tabla guardada
              {pendingOfflineCount > 0 ? ` (${pendingOfflineCount} por enviar)` : ''}.
            </span>
          </div>
        )}
        {boardError && <div className="mg-lb-notice error">{boardError}</div>}

        {/* Personal best highlight */}
        <div className="mg-personal-box">
          <div>
            <small>Tu mejor puntaje ({boardMode === 'shift' ? 'Turno' : 'Infinito'})</small>
            <strong>
              {board?.personal
                ? `${board.personal.score.toLocaleString('es-MX')} pts`
                : 'Sin partidas aún'}
            </strong>
          </div>
          {board?.personal && (
            <div className="mg-personal-rank">
              <span>#{board.personal.rank}</span>
              <small>{board.personal.games_played} partidas</small>
            </div>
          )}
        </div>

        {/* Top leaderboard rows */}
        <div className="mg-lb-list">
          {board?.leaderboard?.length ? (
            board.leaderboard.map((row) => {
              const isMe = row.user_id === user.id;
              const medal =
                row.rank === 1
                  ? '🥇'
                  : row.rank === 2
                    ? '🥈'
                    : row.rank === 3
                      ? '🥉'
                      : `#${row.rank}`;
              return (
                <div key={row.user_id} className={`mg-lb-row ${isMe ? 'me' : ''}`}>
                  <span className={`mg-lb-rank rank-${row.rank}`}>{medal}</span>
                  <div className="mg-lb-player">
                    <strong>
                      {row.user_name}
                      {isMe ? ' (Tú)' : ''}
                    </strong>
                    <small>
                      {ROLE_LABELS[row.user_role] || row.user_role} · {row.customers_served}{' '}
                      clientes
                      {row.grade ? ` · Nota ${row.grade}` : ''}
                    </small>
                  </div>
                  <div className="mg-lb-score">
                    <strong>{row.score.toLocaleString('es-MX')}</strong>
                    <small>pts</small>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="mg-lb-empty">
              <Crown size={24} />
              <p>Todavía no hay puntajes en este modo. ¡Juega la primera partida y toma el #1!</p>
            </div>
          )}
        </div>

        {/* Recent activity feed */}
        {board?.recent && board.recent.length > 0 && (
          <div className="mg-recent">
            <h4>Últimas partidas</h4>
            <ul>
              {board.recent.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <span>
                    <strong>{r.user_name}</strong> · {r.score.toLocaleString('es-MX')} pts
                    {r.grade ? ` (${r.grade})` : ''}
                  </span>
                  <small>{formatRelativeDate(r.played_at)}</small>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
