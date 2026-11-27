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
  CASHIER_Y,
  COUNTER_Y,
  ENTRANCE_POS,
  REGISTER_XS,
  SPECIALTY_LABELS,
  SUPPLIER_SPOT,
  WORLD_H,
  WORLD_W,
  assignCashierTask,
  createInitialState,
  formatShiftClock,
  getCashierAtRegister,
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
        this.tone(420, 0.06, 'triangle', 0.05);
      } else if (cue === 'checkout') {
        this.tone(660, 0.08, 'sine', 0.07, 0);
        this.tone(990, 0.13, 'sine', 0.07, 0.065);
      } else if (cue === 'clean') {
        this.tone(540, 0.07, 'sine', 0.06, 0);
        this.tone(720, 0.07, 'sine', 0.06, 0.055);
        this.tone(960, 0.1, 'sine', 0.055, 0.11);
      } else if (cue === 'restock') {
        this.tone(480, 0.07, 'triangle', 0.06, 0);
        this.tone(620, 0.09, 'triangle', 0.06, 0.06);
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

const SHELF_UNITS = [
  {
    x: 58,
    label: 'Abarrotes',
    items: ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#ec4899'],
  },
  {
    x: 204,
    label: 'Bebidas',
    items: ['#0ea5e9', '#10b981', '#dc2626', '#06b6d4', '#f59e0b', '#6366f1'],
  },
  {
    x: 350,
    label: 'Botanas',
    items: ['#f59e0b', '#ef4444', '#84cc16', '#a855f7', '#fb923c', '#14b8a6'],
  },
  {
    x: 496,
    label: 'Lácteos',
    items: ['#38bdf8', '#f8fafc', '#fde047', '#60a5fa', '#cbd5e1', '#34d399'],
  },
];

function drawStore(ctx: CanvasRenderingContext2D, state: GameState, accentColor: string) {
  const pulse = 0.5 + 0.5 * Math.sin(state.elapsed * 7);

  // 1. Store floor tiles
  ctx.fillStyle = '#f8f6f1';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  ctx.strokeStyle = '#eae5da';
  ctx.lineWidth = 1;
  for (let gx = 40; gx < WORLD_W; gx += 40) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, WORLD_H);
    ctx.stroke();
  }
  for (let gy = 40; gy < WORLD_H; gy += 40) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(WORLD_W, gy);
    ctx.stroke();
  }

  // Outer store walls
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, WORLD_W - 10, WORLD_H - 10);

  // Subtle floor zone labels (helpful visual cues for direct clicking)
  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 10px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PASILLO · TOCA PARA LIMPIAR', 355, 174);

  // Left entrance mat
  roundRect(ctx, 10, ENTRANCE_POS.y - 36, 46, 72, 8);
  ctx.fillStyle = '#e2e8f0';
  ctx.fill();
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.save();
  ctx.translate(28, ENTRANCE_POS.y);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#475569';
  ctx.font = '700 10px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ENTRADA', 0, 4);
  ctx.restore();

  // Bottom exit strips
  ctx.fillStyle = '#e2e8f0';
  roundRect(ctx, 130, WORLD_H - 14, 510, 12, 4);
  ctx.fill();

  // 2. Top Shelves Zone (Surtido)
  const lowStock = state.stock < 35;
  roundRect(ctx, 44, 24, 594, 114, 14);
  ctx.fillStyle = lowStock
    ? `rgba(254, 226, 226, ${0.45 + pulse * 0.35})`
    : 'rgba(241, 245, 249, 0.8)';
  ctx.fill();
  ctx.strokeStyle = lowStock ? '#ef4444' : '#cbd5e1';
  ctx.lineWidth = lowStock ? 2.5 : 1.5;
  ctx.stroke();

  const totalSlots = 24;
  const filledSlots = Math.round((state.stock / 100) * totalSlots);

  SHELF_UNITS.forEach((unit, sIdx) => {
    // Gondola shadow & body
    roundRect(ctx, unit.x + 2, 38, 128, 74, 9);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.08)';
    ctx.fill();

    roundRect(ctx, unit.x, 34, 128, 74, 9);
    ctx.fillStyle = '#78350f';
    ctx.fill();
    roundRect(ctx, unit.x + 5, 39, 118, 64, 6);
    ctx.fillStyle = '#fef3c7';
    ctx.fill();

    // Shelf divider line
    ctx.fillStyle = '#d97706';
    ctx.fillRect(unit.x + 5, 69, 118, 3);

    // Draw individual product items (6 per shelf = 24 total)
    unit.items.forEach((itemColor, iIdx) => {
      const slotNumber = iIdx * 4 + sIdx; // interleave so all 4 shelves empty evenly
      if (slotNumber < filledSlots) {
        const col = iIdx % 3;
        const row = Math.floor(iIdx / 3);
        const ix = unit.x + 14 + col * 37;
        const iy = 45 + row * 31;
        roundRect(ctx, ix, iy, 27, 19, 4);
        ctx.fillStyle = itemColor;
        ctx.fill();
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Highlight bar on package
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(ix + 3, iy + 3, 21, 4);
      }
    });

    // Shelf label
    ctx.fillStyle = '#475569';
    ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(unit.label, unit.x + 64, 127);
  });

  if (lowStock) {
    roundRect(ctx, 274, 12, 134, 22, 11);
    ctx.fillStyle = '#dc2626';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('¡RELLENAR ANAQUELES!', 341, 27);
  }

  // 3. Supplier Receiving Door (Right side)
  const supActive = state.supplier.active;
  roundRect(ctx, 668, 76, 114, 148, 14);
  ctx.fillStyle = supActive ? `rgba(254, 243, 199, ${0.7 + pulse * 0.25})` : '#f1f5f9';
  ctx.fill();
  ctx.strokeStyle = supActive ? '#f59e0b' : '#cbd5e1';
  ctx.lineWidth = supActive ? 3 : 1.5;
  ctx.stroke();

  ctx.fillStyle = supActive ? '#b45309' : '#64748b';
  ctx.font = '700 10px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PROVEEDORES', 725, 96);

  // Loading bay door stripes
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(772, 108, 10, 92);

  if (supActive) {
    // Delivery boxes & rep icon
    roundRect(ctx, 718, 126, 26, 22, 4);
    ctx.fillStyle = '#b45309';
    ctx.fill();
    roundRect(ctx, 738, 144, 24, 20, 4);
    ctx.fillStyle = '#d97706';
    ctx.fill();
    // Delivery person circle
    ctx.beginPath();
    ctx.arc(726, 168, 13, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(726, 166, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#fde68a';
    ctx.fill();

    // Countdown arc or receiving progress bar
    const ratio = clamp01(state.supplier.timeLeft / state.supplier.maxTime);
    ctx.fillStyle = '#78350f';
    ctx.font = '700 10px "DM Sans", system-ui, sans-serif';
    ctx.fillText(`${Math.ceil(state.supplier.timeLeft)}s · ¡Recibir!`, 725, 200);

    roundRect(ctx, 682, 207, 86, 8, 4);
    ctx.fillStyle = '#fde68a';
    ctx.fill();
    roundRect(
      ctx,
      682,
      207,
      86 * (state.supplier.progress > 0 ? state.supplier.progress : ratio),
      8,
      4,
    );
    ctx.fillStyle = state.supplier.progress > 0 ? '#10b981' : '#f59e0b';
    ctx.fill();
  } else {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 10px "DM Sans", system-ui, sans-serif';
    ctx.fillText('Puerta cerrada', 725, 154);
  }

  // 4. Floor Messes (Spills, tracks, wrappers)
  for (const m of state.messes) {
    ctx.save();
    ctx.translate(m.x, m.y);
    const shrink = 1 - m.progress * 0.55;
    ctx.scale(shrink, shrink);
    if (m.kind === 'spill') {
      ctx.fillStyle = `${m.color}cc`;
      ctx.beginPath();
      ctx.ellipse(0, 0, m.size, m.size * 0.72, 0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(m.size * 0.75, -m.size * 0.3, m.size * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.ellipse(-m.size * 0.3, -m.size * 0.2, m.size * 0.3, m.size * 0.16, -0.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (m.kind === 'tracks') {
      ctx.fillStyle = '#78716ccc';
      ctx.beginPath();
      ctx.ellipse(-6, -3, 6, 3.5, 0.4, 0, Math.PI * 2);
      ctx.ellipse(6, 4, 6, 3.5, 0.4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = m.color;
      roundRect(ctx, -8, -6, 16, 12, 3);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();

    // Cleaning progress ring
    if (m.progress > 0) {
      ctx.beginPath();
      ctx.arc(m.x, m.y, 19, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * m.progress);
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  // 5. Checkout Counters (3 Cajas)
  REGISTER_XS.forEach((rx, idx) => {
    const cashier = getCashierAtRegister(state, idx);
    const active = !!cashier && !cashier.moving;
    const queueCount = state.customers.filter(
      (c) => c.state === 'queueing' && c.registerIndex === idx,
    ).length;

    // Queue lane mat
    roundRect(ctx, rx - 30, 224, 60, 148, 12);
    ctx.fillStyle = active ? 'rgba(16, 185, 129, 0.08)' : 'rgba(148, 163, 184, 0.09)';
    ctx.fill();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = active ? 'rgba(16, 185, 129, 0.35)' : '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Counter shadow
    roundRect(ctx, rx - 66, COUNTER_Y - 16, 132, 42, 10);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.09)';
    ctx.fill();

    // Counter body
    roundRect(ctx, rx - 68, COUNTER_Y - 20, 136, 40, 10);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = active ? accentColor : queueCount > 0 ? '#f59e0b' : '#cbd5e1';
    ctx.lineWidth = active || queueCount > 0 ? 2.5 : 1.5;
    ctx.stroke();

    // Conveyor belt (left side of counter)
    roundRect(ctx, rx - 58, COUNTER_Y - 12, 54, 24, 5);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    for (let bx = rx - 48; bx < rx - 8; bx += 12) {
      ctx.beginPath();
      ctx.moveTo(bx, COUNTER_Y - 10);
      ctx.lineTo(bx, COUNTER_Y + 10);
      ctx.stroke();
    }

    // POS Monitor & cash drawer (right side of counter)
    roundRect(ctx, rx + 8, COUNTER_Y - 13, 28, 22, 4);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    roundRect(ctx, rx + 12, COUNTER_Y - 9, 20, 12, 2);
    ctx.fillStyle = active ? '#34d399' : '#64748b';
    ctx.fill();

    // Status LED & Caja number badge
    ctx.beginPath();
    ctx.arc(rx + 52, COUNTER_Y - 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#10b981' : queueCount > 0 ? '#f59e0b' : '#94a3b8';
    ctx.fill();

    // Caja label below counter
    ctx.fillStyle = '#334155';
    ctx.font = '700 12px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Caja ${idx + 1}`, rx, COUNTER_Y + 78);

    // If unattended with waiting customers, pulse a subtle alert tag
    if (!cashier && queueCount > 0) {
      roundRect(ctx, rx - 44, COUNTER_Y + 25, 88, 18, 9);
      ctx.fillStyle = `rgba(245, 158, 11, ${0.8 + pulse * 0.2})`;
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 10px "DM Sans", system-ui, sans-serif';
      ctx.fillText('¡Sin cajero!', rx, COUNTER_Y + 38);
    }
  });

  // 6. Customers
  for (const cust of state.customers) {
    ctx.save();
    ctx.translate(cust.x, cust.y);

    // Shopping cart prop for 'cart' customer
    if (cust.kind === 'cart') {
      roundRect(ctx, -12, 13, 24, 15, 3);
      ctx.fillStyle = '#cbd5e1';
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#f97316';
      ctx.fillRect(-8, 16, 7, 6);
      ctx.fillStyle = '#10b981';
      ctx.fillRect(1, 16, 7, 6);
    }

    // Shadow
    ctx.beginPath();
    ctx.ellipse(0, 5, 14, 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
    ctx.fill();

    // Shoulders / shirt
    ctx.beginPath();
    ctx.ellipse(0, 1, 15, 11, 0, 0, Math.PI * 2);
    ctx.fillStyle = cust.shirtColor;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Head
    ctx.beginPath();
    ctx.arc(0, -1, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#fed7aa';
    ctx.fill();

    // Hair / cap detail
    ctx.beginPath();
    ctx.arc(0, -3.5, 7, Math.PI, Math.PI * 2);
    ctx.fillStyle = cust.kind === 'rushed' ? '#7f1d1d' : '#334155';
    ctx.fill();

    // Type mini-icon
    if (cust.kind === 'rushed') {
      ctx.fillStyle = '#ef4444';
      ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚡', 15, -6);
    } else if (cust.kind === 'messy') {
      ctx.fillStyle = '#d97706';
      ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('💧', 15, -6);
    }

    // Patience bar when queueing
    if (cust.state === 'queueing') {
      const pRatio = clamp01(cust.patience / cust.maxPatience);
      roundRect(ctx, -18, -22, 36, 6, 3);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.25)';
      ctx.fill();
      roundRect(ctx, -18, -22, 36 * pRatio, 6, 3);
      ctx.fillStyle = pRatio > 0.5 ? '#10b981' : pRatio > 0.25 ? '#f59e0b' : '#ef4444';
      ctx.fill();

      // Active checkout scan bar
      if (cust.checkoutProgress > 0) {
        roundRect(ctx, -18, 16, 36, 5, 2.5);
        ctx.fillStyle = '#e2e8f0';
        ctx.fill();
        roundRect(ctx, -18, 16, 36 * clamp01(cust.checkoutProgress), 5, 2.5);
        ctx.fillStyle = accentColor;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // 7. Cashiers (The 3 playable team members!)
  for (const c of state.cashiers) {
    const selected = state.selectedCashier === c.id && state.status === 'playing';
    const bob = c.moving ? Math.sin(c.workAnim) * 2.5 : 0;

    ctx.save();
    ctx.translate(c.x, c.y + bob);

    // Selection ring
    if (selected) {
      ctx.beginPath();
      ctx.arc(0, 0, 24 + pulse * 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = `${c.color}1c`;
      ctx.fill();
    }

    // Tool prop depending on task
    if (c.task === 'clean') {
      const swing = Math.sin(c.workAnim * 1.6) * 0.45;
      ctx.save();
      ctx.rotate(swing);
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(10, 4);
      ctx.lineTo(24, -14);
      ctx.stroke();
      roundRect(ctx, 18, -21, 14, 9, 4);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
      ctx.restore();
    } else if (c.task === 'restock') {
      roundRect(ctx, -11, -24, 22, 14, 3);
      ctx.fillStyle = '#d97706';
      ctx.fill();
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (c.task === 'supplier') {
      roundRect(ctx, 13, -10, 12, 16, 2);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Shadow
    ctx.beginPath();
    ctx.ellipse(0, 6, 16, 11, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.16)';
    ctx.fill();

    // Uniform shoulders
    ctx.beginPath();
    ctx.ellipse(0, 1, 17, 13, 0, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Apron accent
    ctx.beginPath();
    ctx.arc(0, 4, 9, 0, Math.PI);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fill();

    // Head
    ctx.beginPath();
    ctx.arc(0, -2, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#fde68a';
    ctx.fill();

    // Hair
    ctx.beginPath();
    ctx.arc(0, -4.5, 8, Math.PI, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();

    // Name pill
    roundRect(ctx, -23, 15, 46, 16, 8);
    ctx.fillStyle = selected ? c.color : '#1e293b';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(c.name, 0, 26);

    ctx.restore();
  }

  // 8. Sparkle particles
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
    ctx.font = '800 13px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeText(ft.text, ft.x, ft.y);
    ctx.fillStyle = ft.color;
    ctx.fillText(ft.text, ft.x, ft.y);
    ctx.restore();
  }

  // 10. Rush hour edge glow
  if (state.rushTimeLeft > 0) {
    ctx.strokeStyle = `rgba(249, 115, 22, ${0.35 + pulse * 0.45})`;
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, WORLD_W - 8, WORLD_H - 8);
  }
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
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
        // Keep in offline queue so score is never lost on flaky connection
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

  // Main animation loop (60fps render + smooth simulation)
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

  // Keyboard shortcuts (1/2/3 select cashier, Q/W/E/R assign task, Space pauses)
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

  const pendingOfflineCount = readQueuedScores().filter((q) => q.branch_id === branchId).length;

  return (
    <div className="minigame-layout">
      <div className="minigame-stage">
        {/* Compact HUD bar */}
        <div className="mg-hud">
          <div className="mg-hud-group">
            {hud.mode === 'shift' ? (
              <div className={`mg-pill ${hud.rushActive ? 'rush' : ''}`}>
                <Clock size={15} />
                <span>
                  {hud.shiftPeriod === 'morning' ? 'Mañana' : 'Tarde'} {hud.shiftClock} ·{' '}
                  <strong>{formatTimer(hud.timeLeft)}</strong>
                </span>
              </div>
            ) : (
              <div className={`mg-pill ${hud.rushActive ? 'rush' : ''}`}>
                <Flame size={15} />
                <span>
                  Oleada <strong>{hud.wave}</strong>
                </span>
                <span className="mg-hearts" aria-label={`${hud.lives} vidas restantes`}>
                  {Array.from({ length: hud.maxLives }, (_, i) => (
                    <Heart
                      key={i}
                      size={14}
                      fill={i < hud.lives ? '#ef4444' : 'none'}
                      color={i < hud.lives ? '#ef4444' : '#cbd5e1'}
                    />
                  ))}
                </span>
              </div>
            )}

            <div className="mg-pill score">
              <Trophy size={15} />
              <strong>{hud.score.toLocaleString('es-MX')}</strong>
              <small>pts</small>
              {hud.combo > 1 && <span className="mg-combo">x{hud.combo}</span>}
            </div>

            <div className="mg-pill subtle">
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
              {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
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
                  {hud.status === 'paused' ? <Play size={16} /> : <Pause size={16} />}
                </button>
                <button
                  type="button"
                  className="secondary mg-icon-btn"
                  title="Reiniciar partida"
                  aria-label="Reiniciar partida"
                  onClick={() => startGame(hud.mode, hud.shiftPeriod)}
                >
                  <RotateCcw size={16} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Aerial Top-Down Store Canvas */}
        <div className="mg-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="mg-canvas"
            onPointerDown={onCanvasPointerDown}
            aria-label="Mapa aéreo de la tienda Hora Pico"
          />

          {hud.banner && hud.status === 'playing' && (
            <div className={`mg-banner ${hud.banner.tone}`}>{hud.banner.text}</div>
          )}

          {/* Start Screen Overlay */}
          {hud.status === 'idle' && (
            <div className="mg-overlay">
              <div className="mg-overlay-card">
                <div className="mg-title-row">
                  <div className="mg-title-icon">
                    <Gamepad2 size={24} />
                  </div>
                  <div>
                    <h2>Hora Pico en Mostrador</h2>
                    <p>
                      Coordina a Sofía, Mateo y Valeria entre las 3 cajas, los anaqueles y la
                      limpieza.
                    </p>
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
                    <Clock size={18} />
                    <strong>Turno Completo</strong>
                    <small>
                      2 min 30 s · Sobrevive el turno y saca calificación S en tu corte.
                    </small>
                  </button>
                  <button
                    type="button"
                    className={`mg-mode-card ${selectedMode === 'endless' ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedMode('endless');
                      setBoardMode('endless');
                    }}
                  >
                    <Flame size={18} />
                    <strong>Hora Pico Infinita</strong>
                    <small>5 vidas · Oleadas cada vez más intensas hasta romper el récord.</small>
                  </button>
                </div>

                {selectedMode === 'shift' && (
                  <div className="mg-shift-toggle">
                    <span>Horario del turno:</span>
                    <button
                      type="button"
                      className={shiftPeriod === 'morning' ? 'selected' : 'secondary'}
                      onClick={() => setShiftPeriod('morning')}
                    >
                      Mañana (07:30–15:00)
                    </button>
                    <button
                      type="button"
                      className={shiftPeriod === 'afternoon' ? 'selected' : 'secondary'}
                      onClick={() => setShiftPeriod('afternoon')}
                    >
                      Tarde (15:00–21:30)
                    </button>
                  </div>
                )}

                <div className="mg-tips">
                  <span>🛒 Carrito lleno: paga doble, vacía más anaquel</span>
                  <span>⚡ Apurado: poca paciencia, abre caja rápido</span>
                  <span>💧 Descuidado: deja derrames, mándalo limpiar</span>
                  <span>🚚 Proveedor: recíbelo a tiempo para +38% surtido</span>
                </div>

                <button
                  type="button"
                  className="primary mg-start-btn"
                  onClick={() => startGame(selectedMode, shiftPeriod)}
                >
                  <Play size={18} />
                  Abrir la tienda
                </button>
              </div>
            </div>
          )}

          {/* Pause Overlay */}
          {hud.status === 'paused' && (
            <div className="mg-overlay">
              <div className="mg-overlay-card compact">
                <h3>Turno en pausa</h3>
                <p>
                  Atiende el mostrador real con calma; tu partida sigue exactamente donde quedó.
                </p>
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
                          <WifiOff size={13} /> Guardado en este equipo; se subirá al conectar.
                        </span>
                      )}
                      {saveState.kind === 'error' && (
                        <span className="mg-record-badge warn">{saveState.message}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mg-summary-grid">
                  <div>
                    <span>Clientes atendidos</span>
                    <strong>{hud.customersServed}</strong>
                  </div>
                  <div>
                    <span>Clientes perdidos</span>
                    <strong>{hud.customersLost}</strong>
                  </div>
                  <div>
                    <span>Venta simulada</span>
                    <strong>{money(BigInt(hud.salesCents))}</strong>
                  </div>
                  <div>
                    <span>Racha máxima</span>
                    <strong>x{hud.maxCombo}</strong>
                  </div>
                  <div>
                    <span>Manchas limpiadas</span>
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
                    className="primary"
                    onClick={() => startGame(hud.mode, hud.shiftPeriod)}
                  >
                    <RotateCcw size={16} />
                    Jugar otra vez
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
                    Cambiar a {hud.mode === 'shift' ? 'Hora Pico Infinita' : 'Turno Completo'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Cashier Quick-Control Dock */}
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
                      {idx + 1}. {c.name}
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
                    className={`mg-task-btn ${c.task === 'restock' ? 'active' : ''}`}
                    disabled={hud.status !== 'playing'}
                    onClick={() => sendCashier(c.id, 'restock')}
                  >
                    <Package size={14} /> Rellenar
                  </button>
                  <button
                    type="button"
                    className={`mg-task-btn ${c.task === 'clean' ? 'active' : ''}`}
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
          Consejo: también puedes tocar directamente una caja, los anaqueles, una mancha o la puerta
          de proveedores en el mapa. En PC: teclas <strong>1-2-3</strong> (cajero),{' '}
          <strong>Q</strong> Caja, <strong>W</strong> Rellenar, <strong>E</strong> Limpiar,{' '}
          <strong>R</strong> Proveedor, <strong>Espacio</strong> Pausa.
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
