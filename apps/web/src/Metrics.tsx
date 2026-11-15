import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, Table2, BarChart3 } from 'lucide-react';
import { money } from '../../../packages/domain/index.js';
import { request } from './api';
import { addDays } from './ScheduleBoard';

// Métricas compara la sucursal elegida al iniciar sesión con el periodo anterior de igual
// duración. Reportes lista cada registro; aquí se ven tendencias.
type Tab =
  'ventas' | 'compras' | 'proveedores' | 'empleados' | 'rentabilidad' | 'efectivo' | 'sucursales';
const tabs: [Tab, string][] = [
  ['ventas', 'Ventas'],
  ['compras', 'Compras'],
  ['proveedores', 'Proveedores'],
  ['empleados', 'Empleados'],
  ['rentabilidad', 'Rentabilidad'],
  ['efectivo', 'Control de efectivo'],
  // Only the owner sees every branch.
  ['sucursales', 'Sucursales'],
];
type Preset = '7' | '30' | 'month' | 'last-month' | '90' | 'year' | 'custom';
const presets: [Preset, string][] = [
  ['7', '7 días'],
  ['30', '30 días'],
  ['month', 'Este mes'],
  ['last-month', 'Mes pasado'],
  ['90', '90 días'],
  ['year', 'Este año'],
  ['custom', 'Otro'],
];
function period(preset: Preset, today: string): [string, string] {
  const monthStart = `${today.slice(0, 8)}01`;
  if (preset === '7') return [addDays(today, -6), today];
  if (preset === '90') return [addDays(today, -89), today];
  if (preset === 'month') return [monthStart, today];
  if (preset === 'year') return [`${today.slice(0, 4)}-01-01`, today];
  if (preset === 'last-month') {
    const end = addDays(monthStart, -1);
    return [`${end.slice(0, 8)}01`, end];
  }
  return [addDays(today, -29), today];
}
const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

// Grouping of the trend charts.
type Grain = 'day' | 'week' | 'month';
const grains: [Grain, string][] = [
  ['day', 'Día'],
  ['week', 'Semana'],
  ['month', 'Mes'],
];
const MAX_DAILY = 92;
const defaultGrain = (days: number): Grain => (days <= 31 ? 'day' : days <= 120 ? 'week' : 'month');
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
// A day belongs to the week that starts on its Monday, and to its calendar month.
function bucketOf(date: string, grain: Grain) {
  if (grain === 'month') return date.slice(0, 7);
  if (grain === 'week') return addDays(date, -((weekday(date) + 6) % 7));
  return date;
}
const fmt = (options: Intl.DateTimeFormatOptions, date: string) =>
  new Intl.DateTimeFormat('es-MX', { ...options, timeZone: 'UTC' })
    .format(new Date(`${date.length === 7 ? `${date}-01` : date}T12:00:00Z`))
    .replace('.', '');
function bucketLabel(key: string, grain: Grain) {
  if (grain === 'month') return fmt({ month: 'short' }, key);
  if (grain === 'week') return fmt({ day: 'numeric', month: 'short' }, key);
  return fmt({ day: 'numeric' }, key);
}
function bucketTitle(key: string, grain: Grain, from: string, to: string) {
  if (grain === 'month') return fmt({ month: 'long', year: 'numeric' }, key);
  if (grain === 'week') {
    // The first and last weeks may be cut by the range.
    const start = key < from ? from : key,
      end = addDays(key, 6) < to ? addDays(key, 6) : to;
    return `Semana del ${fmt({ day: 'numeric', month: 'short' }, start)} al ${fmt({ day: 'numeric', month: 'short' }, end)}`;
  }
  return fmt({ weekday: 'long', day: 'numeric', month: 'long' }, key);
}
const shortDate = (date: string) => fmt({ day: 'numeric', month: 'short', year: 'numeric' }, date);
const weekdays = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const weekdayNames = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];

// Every key of the range, so a day without cuts still shows as an empty slot.
function bucketKeys(from: string, to: string, grain: Grain) {
  const keys: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const k = bucketOf(d, grain);
    if (keys[keys.length - 1] !== k) keys.push(k);
  }
  return keys;
}
// Sums daily rows into buckets. The previous period is moved forward by its length first,
// so each bucket faces the same stretch of the period before.
function bucketize<T extends { date: string }>(
  rows: T[],
  grain: Grain,
  pick: (row: T) => Record<string, number>,
  offset = 0,
) {
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = bucketOf(offset ? addDays(r.date, offset) : r.date, grain);
    const sum = out.get(k) || {};
    for (const [name, v] of Object.entries(pick(r))) sum[name] = (sum[name] || 0) + v;
    out.set(k, sum);
  }
  return out;
}

const pesos = (cents: number) => money(BigInt(Math.round(cents)));
const compact = (cents: number) => {
  const sign = cents < 0 ? '-' : '',
    v = Math.abs(cents) / 100;
  if (v >= 1_000_000)
    return `${sign}$${(v / 1_000_000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} M`;
  if (v >= 1_000)
    return `${sign}$${(v / 1_000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} mil`;
  return `${sign}$${v.toLocaleString('es-MX', { maximumFractionDigits: 0 })}`;
};
const percent = (ratio: number, digits = 1) =>
  `${(ratio * 100).toLocaleString('es-MX', { maximumFractionDigits: digits })}%`;
const num = (cents: string | number | undefined) => Number(cents ?? 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// --- Indicadores ----------------------------------------------------------------------
type Tone = 'good' | 'bad' | 'neutral';
// How a figure moved against the previous period. `upIs` says which direction is good news.
function Change({
  now,
  before,
  upIs = 'good',
  points,
  brief,
}: {
  now: number;
  before: number;
  upIs?: Tone;
  points?: boolean;
  // Without «que el periodo anterior», for a table cell.
  brief?: boolean;
}) {
  if (!points && !before)
    return (
      <small className="mt-change">
        {brief ? 'Sin datos antes' : 'Sin datos del periodo anterior'}
      </small>
    );
  const delta = points ? now - before : (now - before) / Math.abs(before);
  const flat = Math.abs(delta) < 0.0005;
  const up = delta > 0;
  const tone: Tone =
    flat || upIs === 'neutral' ? 'neutral' : up === (upIs === 'good') ? 'good' : 'bad';
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const amount = points
    ? `${(Math.abs(delta) * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 })} pts`
    : percent(Math.abs(delta));
  return (
    <small className={`mt-change ${tone}`}>
      <Icon size={13} aria-hidden />
      {flat ? 'Igual' : `${up ? 'Sube' : 'Baja'} ${amount}`}
      {!brief && ' que el periodo anterior'}
    </small>
  );
}
// A comparison with few days on record (the app was new, or the store closed) deserves a note.
function Coverage({ now, before, what }: { now: number; before: number; what: string }) {
  if (!before || before >= now * 0.8) return null;
  return (
    <small>
      El periodo anterior solo tiene {plural(before, `día con ${what}`, `días con ${what}`)}
    </small>
  );
}
function Stat({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="mt-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {children}
    </div>
  );
}

// --- Gráficas -------------------------------------------------------------------------
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
// Round axis steps: 1, 2 or 5 times a power of ten.
function niceMax(max: number, ticks = 4) {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / ticks,
    pow = 10 ** Math.floor(Math.log10(raw)),
    step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  return { top: Math.ceil(max / step) * step, step };
}
const SERIES = { cash: '#2a78d6', card: '#eb6834' };
type Segment = { name: string; value: number; color: string };
type Bar = {
  key: string;
  label: string;
  title: string;
  value: number | null;
  segments?: Segment[];
  previous?: number | null;
  // A second amount drawn below zero in red, such as the shortages under the overages.
  below?: number;
  tip: [string, string][];
};
// Vertical bars from a zero baseline, with an optional dashed line for the previous period.
function BarChart({
  bars,
  axis,
  top: fixedTop,
  height = 200,
}: {
  bars: Bar[];
  axis: (v: number) => string;
  top?: number;
  height?: number;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const values = bars.flatMap((b) => [b.value ?? 0, b.previous ?? 0, -(b.below ?? 0)]);
  // The axis always holds zero; a negative value (a loss) extends it below.
  const high = Math.max(0, ...values),
    low = Math.min(0, ...values);
  const { step } = fixedTop ? { step: fixedTop / 4 } : niceMax(high - low);
  const top = fixedTop ?? Math.max(step, Math.ceil(high / step) * step),
    floor = fixedTop ? 0 : Math.floor(low / step) * step;
  const left = 58,
    right = 8,
    pad = 8,
    bottom = 24;
  const plot = Math.max(0, width - left - right);
  const band = bars.length ? plot / bars.length : 0;
  const barW = Math.max(1, Math.min(36, band - 2, band * 0.72));
  const y = (v: number) =>
    pad + ((height - pad - bottom) * (top - Math.max(floor, Math.min(v, top)))) / (top - floor);
  const x = (i: number) => left + band * i + band / 2;
  // Labels thin out so they never collide.
  const labelWidth = Math.max(...bars.map((b) => b.label.length), 1) * 6.5 + 12;
  const every = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plot / labelWidth))));
  const ticks: number[] = [];
  for (let i = 0; floor + i * step <= top + step / 2; i++) ticks.push(floor + i * step);
  const prev = bars.map((b, i) => (b.previous == null ? null : ([x(i), y(b.previous)] as const)));
  const prevPath = prev
    .map((p, i) => (p ? `${i && prev[i - 1] ? 'L' : 'M'}${p[0]},${p[1]}` : ''))
    .join('');
  const radius = Math.min(4, barW / 2);
  // Rounded on top only: the bar stands on the baseline.
  const column = (cx: number, y0: number, y1: number, round: boolean) => {
    const h = y0 - y1,
      r = round ? Math.min(radius, h) : 0,
      l = cx - barW / 2,
      rr = l + barW;
    return `M${l},${y0}V${y1 + r}Q${l},${y1} ${l + r},${y1}H${rr - r}Q${rr},${y1} ${rr},${y1 + r}V${y0}Z`;
  };
  const tip = hover != null ? bars[hover] : null;
  return (
    <div className="mt-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Gráfica de barras">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={left}
                x2={width - right}
                y1={y(t)}
                y2={y(t)}
                className={t ? 'grid' : 'base'}
              />
              <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                {axis(t)}
              </text>
            </g>
          ))}
          {bars.map((b, i) => {
            const base = y(0);
            let acc = 0;
            const segs = b.segments || (b.value ? [{ name: '', value: b.value, color: '' }] : []);
            const shown = segs.filter((s) => s.value > 0);
            const down = b.below
              ? b.below
              : !b.segments && (b.value ?? 0) < 0
                ? -(b.value as number)
                : 0;
            const loss = down > 0;
            return (
              <g key={b.key} className={hover != null && hover !== i ? 'dim' : ''}>
                {loss && (
                  // Hangs from the baseline, rounded at its lower end.
                  <path
                    d={(() => {
                      const y0 = base,
                        y1 = y(-down),
                        r = Math.min(radius, y1 - y0),
                        l = x(i) - barW / 2,
                        rr = l + barW;
                      return `M${l},${y0}V${y1 - r}Q${l},${y1} ${l + r},${y1}H${rr - r}Q${rr},${y1} ${rr},${y1 - r}V${y0}Z`;
                    })()}
                    className="bar negative"
                  />
                )}
                {shown.map((s, j) => {
                  const y0 = y(acc) - (j ? 1 : 0),
                    y1 = y(acc + s.value) + (j < shown.length - 1 ? 1 : 0);
                  acc += s.value;
                  return (
                    <path
                      key={s.name || j}
                      d={column(x(i), y0, Math.min(y1, y0), j === shown.length - 1)}
                      style={s.color ? { fill: s.color } : undefined}
                      className="bar"
                    />
                  );
                })}
                {i % every === 0 && (
                  <text x={x(i)} y={height - 6} textAnchor="middle" className="tick">
                    {b.label}
                  </text>
                )}
              </g>
            );
          })}
          {prevPath && <path d={prevPath} className="previous" />}
          {prev.map(
            (p, i) =>
              p &&
              hover === i && <circle key={i} cx={p[0]} cy={p[1]} r={4} className="previous-dot" />,
          )}
          {bars.map((b, i) => (
            <rect
              key={b.key}
              x={left + band * i}
              y={0}
              width={band}
              height={height}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onClick={() => setHover(i)}
            />
          ))}
        </svg>
      )}
      {tip && hover != null && (
        <div
          className="mt-tip"
          style={{
            left: Math.min(Math.max(x(hover), 90), width - 90),
          }}
        >
          <strong>{tip.title}</strong>
          {tip.tip.map(([k, v]) => (
            <span key={k}>
              {k}
              <b>{v}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
// Horizontal bars for a few named groups (turnos, cajas): name, bar, value.
function Rows({
  items,
  scale,
  danger,
}: {
  items: { key: string; label: string; sub?: string; value: number; text: string }[];
  // A fixed full bar, such as 1 for percentages; otherwise the largest value.
  scale?: number;
  // Bars that measure something bad, such as shortages, are drawn in red.
  danger?: boolean;
}) {
  const max = scale ?? Math.max(0, ...items.map((i) => i.value));
  return (
    <ul className={danger ? 'mt-rows danger' : 'mt-rows'}>
      {items.map((i) => (
        <li key={i.key}>
          <div>
            <strong>{i.label}</strong>
            {i.sub && <small>{i.sub}</small>}
          </div>
          <span className="mt-track">
            <i
              style={{
                width: `${max > 0 && i.value > 0 ? Math.max(2, (i.value / max) * 100) : 0}%`,
              }}
            />
          </span>
          <b>{i.text}</b>
        </li>
      ))}
    </ul>
  );
}
type Legend = { label: string; color?: string; dashed?: boolean; negative?: boolean };
// One chart with its title, legend and a table view of the same numbers.
function Panel({
  title,
  note,
  legend,
  table,
  children,
}: {
  title: string;
  note?: string;
  legend?: Legend[];
  table?: { headers: string[]; rows: string[][] };
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card mt-panel">
      <header>
        <div>
          <h2>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        {table && (
          <button
            className="mt-toggle"
            onClick={() => setAsTable(!asTable)}
            aria-pressed={asTable}
            title={asTable ? 'Ver gráfica' : 'Ver como tabla'}
          >
            {asTable ? <BarChart3 size={15} /> : <Table2 size={15} />}
            {asTable ? 'Gráfica' : 'Tabla'}
          </button>
        )}
      </header>
      {legend && !asTable && (
        <ul className="mt-legend">
          {legend.map((l) => (
            <li key={l.label}>
              <i
                className={l.dashed ? 'dashed' : l.negative ? 'negative' : ''}
                style={l.color ? { background: l.color } : undefined}
              />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      {asTable && table ? (
        <div className="table-wrap">
          <table className="rp-table mt-table">
            <thead>
              <tr>
                {table.headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} data-label={table.headers[j]}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </section>
  );
}
const Empty = ({ text }: { text: string }) => <p className="mt-empty">{text}</p>;

// --- Pantalla -------------------------------------------------------------------------
export default function Metrics({
  branchId,
  branchName,
  today,
  owner = false,
}: {
  branchId: string;
  branchName: string;
  today: string;
  owner?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('ventas'),
    [preset, setPreset] = useState<Preset>('30'),
    [custom, setCustom] = useState<[string, string]>([addDays(today, -29), today]),
    [chosenGrain, setGrain] = useState<Grain | null>(null),
    [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [branches, setBranches] = useState<any>(null);
  const [from, to] = preset === 'custom' ? custom : period(preset, today);
  const days = dayCount(from, to);
  const grain =
    chosenGrain && !(chosenGrain === 'day' && days > MAX_DAILY) ? chosenGrain : defaultGrain(days);
  useEffect(() => {
    if (!from || !to || from > to) return;
    let current = true;
    setLoading(true);
    setError('');
    request(`/metrics?branch_id=${branchId}&from=${from}&to=${to}`)
      .then((r) => current && setData(r))
      .catch((e) => current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [branchId, from, to]);
  // The comparison reads every branch, so it loads only when its tab is open.
  const comparing = owner && tab === 'sucursales';
  useEffect(() => {
    if (!comparing || !from || !to || from > to) return;
    let current = true;
    request(`/metrics/branches?from=${from}&to=${to}`)
      .then((r) => current && setBranches(r))
      .catch((e) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [comparing, from, to]);
  const compared =
    branches && branches.range.from === from && branches.range.to === to ? branches : null;
  // Only the answer for the dates on screen is drawn.
  const ready = data && data.range.from === from && data.range.to === to ? data : null;
  return (
    <div className="metrics">
      <div className="rp-bar">
        <div className="rp-periods" role="group" aria-label="Periodo">
          {presets.map(([key, text]) => (
            <button
              key={key}
              className={preset === key ? 'selected' : ''}
              aria-pressed={preset === key}
              onClick={() => {
                if (key === 'custom') setCustom([from, to]);
                setPreset(key);
              }}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {preset === 'custom' && (
        <div className="rp-dates">
          <label>
            Desde
            <input
              type="date"
              value={custom[0]}
              max={custom[1]}
              onChange={(e) => setCustom([e.target.value, custom[1]])}
            />
          </label>
          <label>
            Hasta
            <input
              type="date"
              value={custom[1]}
              min={custom[0]}
              max={today}
              onChange={(e) => setCustom([custom[0], e.target.value])}
            />
          </label>
        </div>
      )}
      <div className="mt-head">
        <div className="rp-choice" role="group" aria-label="Tema">
          {tabs
            .filter(([key]) => key !== 'sucursales' || owner)
            .map(([key, text]) => (
              <button
                key={key}
                className={tab === key ? 'selected' : ''}
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
              >
                {text}
              </button>
            ))}
        </div>
        {['ventas', 'compras', 'rentabilidad', 'efectivo'].includes(tab) && (
          <div className="rp-choice mt-grain" role="group" aria-label="Agrupar por">
            {grains.map(([key, text]) => (
              <button
                key={key}
                className={grain === key ? 'selected' : ''}
                aria-pressed={grain === key}
                disabled={key === 'day' && days > MAX_DAILY}
                title={key === 'day' && days > MAX_DAILY ? 'Disponible hasta 92 días' : undefined}
                onClick={() => setGrain(key)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="rp-context">
        {comparing ? 'Todas las sucursales activas' : branchName} ·{' '}
        <strong>
          {shortDate(from)} – {shortDate(to)}
        </strong>
        {ready && (
          <>
            {' '}
            · comparado con {shortDate(ready.previous.from)} – {shortDate(ready.previous.to)}
          </>
        )}
        {loading && data && <span> · Actualizando…</span>}
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!ready ? (
        !error && <p className="rp-note">Cargando métricas…</p>
      ) : tab === 'ventas' ? (
        <SalesMetrics m={ready} grain={grain} days={days} />
      ) : comparing ? (
        compared ? (
          <BranchMetrics c={compared} current={branchId} />
        ) : (
          <p className="rp-note">Cargando sucursales…</p>
        )
      ) : tab === 'efectivo' ? (
        <CashMetrics m={ready} grain={grain} />
      ) : tab === 'rentabilidad' ? (
        <ProfitMetrics m={ready} grain={grain} />
      ) : tab === 'empleados' ? (
        <EmployeeMetrics m={ready} />
      ) : tab === 'proveedores' ? (
        <SupplierMetrics m={ready} days={days} />
      ) : (
        <PurchaseMetrics m={ready} grain={grain} days={days} />
      )}
    </div>
  );
}

// The trend of one daily measure, with the previous period aligned bucket by bucket.
function trend(
  m: any,
  rows: any[],
  previousRows: any[],
  grain: Grain,
  pick: (r: any) => Record<string, number>,
) {
  const offset = dayCount(m.previous.from, m.previous.to);
  const now = bucketize(rows, grain, pick),
    before = bucketize(previousRows, grain, pick, offset);
  return bucketKeys(m.range.from, m.range.to, grain).map((key) => ({
    key,
    now: now.get(key),
    before: before.get(key),
  }));
}
function weekdayRows(rows: any[], field: string) {
  return weekdays.map((name, i) => {
    const r = rows.find((w) => w.weekday === i + 1);
    return { name, full: weekdayNames[i], days: r?.days ?? 0, avg: r ? num(r[field]) / r.days : 0 };
  });
}

function SalesMetrics({ m, grain, days }: { m: any; grain: Grain; days: number }) {
  const s = m.sales,
    t = s.totals,
    p = s.previous.totals;
  const sales = num(t.sales_cents),
    before = num(p.sales_cents);
  const card = sales ? num(t.card_cents) / sales : 0,
    cardBefore = before ? num(p.card_cents) / before : 0;
  if (!t.cuts)
    return (
      <section className="card mt-panel">
        <Empty text="No hay cortes en este periodo. Las ventas salen de los cortes de cada turno." />
      </section>
    );
  const series = trend(m, s.by_day, s.previous.by_day, grain, (r) => ({
    sales: num(r.sales_cents),
    card: num(r.card_cents),
    cuts: r.cuts,
  }));
  const grainName = { day: 'día', week: 'semana', month: 'mes' }[grain];
  const bars: Bar[] = series.map(({ key, now, before }) => ({
    key,
    label: bucketLabel(key, grain),
    title: bucketTitle(key, grain, m.range.from, m.range.to),
    value: now?.sales ?? 0,
    // A stretch without records is a gap in the line, not a zero.
    previous: before?.sales ?? null,
    tip: [
      ['Ventas', pesos(now?.sales ?? 0)],
      ['Periodo anterior', before ? pesos(before.sales) : 'Sin registros'],
      ['Cortes', String(now?.cuts ?? 0)],
    ],
  }));
  const mix: Bar[] = series.map(({ key, now }) => {
    const total = now?.sales ?? 0,
      cardShare = total ? (now?.card ?? 0) / total : 0;
    return {
      key,
      label: bucketLabel(key, grain),
      title: bucketTitle(key, grain, m.range.from, m.range.to),
      value: total ? 1 : null,
      segments: total
        ? [
            { name: 'Efectivo', value: 1 - cardShare, color: SERIES.cash },
            { name: 'Tarjeta', value: cardShare, color: SERIES.card },
          ]
        : [],
      tip: total
        ? [
            ['Efectivo', `${pesos(total - (now?.card ?? 0))} · ${percent(1 - cardShare)}`],
            ['Tarjeta', `${pesos(now?.card ?? 0)} · ${percent(cardShare)}`],
          ]
        : [['Sin cortes', '']],
    };
  });
  const week = weekdayRows(s.by_weekday, 'sales_cents');
  const shifts = ['Mañana', 'Tarde'].map((label) => {
    const r = s.by_shift.find((x: any) => x.label === label);
    return { label, cuts: r?.cuts ?? 0, sales: num(r?.sales_cents) };
  });
  const registers = s.by_register.map((r: any) => ({
    n: r.register_number,
    cuts: r.cuts,
    sales: num(r.sales_cents),
  }));
  return (
    <>
      <div className="mt-stats">
        <Stat label="Ventas" value={pesos(sales)}>
          <Change now={sales} before={before} />
          <Coverage now={t.days} before={p.days} what="cortes" />
        </Stat>
        <Stat label="Promedio por día" value={pesos(sales / t.days)}>
          <small>{plural(t.days, 'día con cortes', 'días con cortes')}</small>
        </Stat>
        <Stat label="Venta promedio por turno" value={pesos(sales / t.cuts)}>
          <Change now={sales / t.cuts} before={p.cuts ? before / p.cuts : 0} />
        </Stat>
        <Stat label="Pagado con tarjeta" value={percent(card)}>
          <Change now={card} before={cardBefore} upIs="neutral" points />
        </Stat>
      </div>
      <Panel
        title={`Ventas por ${grainName}`}
        note="Cada barra suma los cortes de ese periodo. La línea punteada es el periodo anterior, alineado día por día."
        legend={[{ label: 'Este periodo' }, { label: 'Periodo anterior', dashed: true }]}
        table={{
          headers: ['Periodo', 'Ventas', 'Periodo anterior', 'Cortes'],
          rows: bars.map((b) => [b.title, ...b.tip.map(([, v]) => v)]),
        }}
      >
        <BarChart bars={bars} axis={compact} />
      </Panel>
      <div className="mt-pair">
        <Panel
          title="Mañana contra tarde"
          note="Total vendido en cada turno y su venta promedio por corte."
        >
          <Rows
            items={shifts.map((x) => ({
              key: x.label,
              label: `Turno ${x.label.toLowerCase()}`,
              sub: x.cuts
                ? `${plural(x.cuts, 'corte', 'cortes')} · ${pesos(x.sales / x.cuts)} por corte`
                : 'Sin cortes',
              value: x.sales,
              text: pesos(x.sales),
            }))}
          />
        </Panel>
        <Panel title="Por caja" note="Total vendido en cada caja y su venta promedio por corte.">
          <Rows
            items={registers.map((r: any) => ({
              key: String(r.n),
              label: `Caja ${r.n}`,
              sub: `${plural(r.cuts, 'corte', 'cortes')} · ${pesos(r.sales / r.cuts)} por corte`,
              value: r.sales,
              text: pesos(r.sales),
            }))}
          />
        </Panel>
      </div>
      <Panel
        title="Por día de la semana"
        note="Venta promedio de cada día de la semana, contando solo los días con cortes."
        table={{
          headers: ['Día', 'Venta promedio', 'Días con cortes'],
          rows: week.map((w) => [w.full, pesos(w.avg), String(w.days)]),
        }}
      >
        <BarChart
          bars={week.map((w) => ({
            key: w.name,
            label: w.name,
            title: `Los ${w.full}`,
            value: w.avg,
            tip: [
              ['Venta promedio', pesos(w.avg)],
              ['Días con cortes', String(w.days)],
            ],
          }))}
          axis={compact}
        />
      </Panel>
      <Panel
        title="Efectivo y tarjeta"
        note={`Qué parte de lo vendido en cada ${grainName} se pagó con tarjeta.`}
        legend={[
          { label: 'Efectivo', color: SERIES.cash },
          { label: 'Tarjeta', color: SERIES.card },
        ]}
        table={{
          headers: ['Periodo', 'Efectivo', 'Tarjeta'],
          rows: mix.filter((b) => b.value).map((b) => [b.title, ...b.tip.map(([, v]) => v)]),
        }}
      >
        <BarChart bars={mix} axis={(v) => percent(v, 0)} top={1} />
      </Panel>
      {days < 7 && (
        <p className="rp-note">
          Con menos de una semana, las comparaciones por día de la semana dicen poco: elige 30 o 90
          días.
        </p>
      )}
    </>
  );
}

// A plain table that stacks into cards on a phone.
function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    <div className="table-wrap">
      <table className="rp-table mt-table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, i) => (
                <td key={i} data-label={headers[i]}>
                  <div>{c}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const RANKED = 10;
// A rise in the average ticket this large is worth a look.
const RISE = 0.1;
const STOPPED_TIMES = 3,
  STOPPED_DAYS = 7;
// Proveedores: who takes the money, how often they come and who stopped coming.
function SupplierMetrics({ m, days }: { m: any; days: number }) {
  const [all, setAll] = useState(false);
  const list = (m.suppliers as any[]).map((x) => ({
    ...x,
    net: num(x.net_cents),
    before: num(x.previous_net_cents),
    avg: x.tickets ? num(x.net_cents) / x.tickets : 0,
    avgBefore: x.previous_tickets ? num(x.previous_net_cents) / x.previous_tickets : 0,
  }));
  const current = list.filter((x) => x.tickets > 0);
  const previousCount = list.filter((x) => x.previous_tickets > 0).length;
  const total = current.reduce((sum, x) => sum + x.net, 0);
  const share = (cents: number) => (total > 0 ? cents / total : 0);
  const top5 = share(current.slice(0, 5).reduce((sum, x) => sum + x.net, 0));
  // How often a supplier comes: the days of the period over the days it came.
  const frequency = (x: any) =>
    x.days >= 2
      ? `cada ${(days / x.days).toLocaleString('es-MX', { maximumFractionDigits: 1 })} días`
      : x.days === 1
        ? '1 visita'
        : 'sin visitas';
  // Comparable: at least two tickets in each period, so one big order doesn't decide it.
  const comparable = current.filter((x) => x.tickets >= 2 && x.previous_tickets >= 2);
  const rising = comparable
    .map((x) => ({ ...x, change: x.avg / x.avgBefore - 1 }))
    .filter((x) => x.change >= RISE)
    .sort((a, b) => b.change - a.change);
  // A supplier stopped coming when it has been away at least three times its usual gap
  // (and a week): a weekly supplier missing from a 7-day period is not news.
  const stopped = list
    .map((x) => {
      const visits = x.days + x.previous_days;
      const usual = (days * 2) / visits;
      const away = dayCount(x.last_visit, m.range.to) - 1;
      return { ...x, usual, away, total: x.net + x.before };
    })
    .filter((x) => x.away >= Math.max(STOPPED_DAYS, x.usual * STOPPED_TIMES))
    .sort((a, b) => b.total - a.total);
  const types = new Map<string, { label: string; net: number; suppliers: number }>();
  for (const x of current) {
    const label = x.product_type.trim() || 'Sin tipo';
    const key = label.toLocaleLowerCase('es-MX');
    const t = types.get(key) || { label, net: 0, suppliers: 0 };
    t.net += x.net;
    t.suppliers++;
    types.set(key, t);
  }
  const byType = [...types.values()].sort((a, b) => b.net - a.net);
  if (!current.length && !stopped.length)
    return (
      <section className="card mt-panel">
        <Empty text="No hay tickets de proveedores en este periodo ni en el anterior." />
      </section>
    );
  const ranked = all ? current : current.slice(0, RANKED);
  return (
    <>
      <div className="mt-stats">
        <Stat label="Proveedores con compras" value={String(current.length)}>
          <Change now={current.length} before={previousCount} upIs="neutral" />
        </Stat>
        <Stat label="Los 5 principales" value={total > 0 ? percent(top5) : '—'}>
          <small>
            {current.length <= 5
              ? `Solo ${plural(current.length, 'proveedor tuvo', 'proveedores tuvieron')} compras`
              : 'del gasto neto del periodo'}
          </small>
        </Stat>
        <Stat label="Ticket promedio al alza" value={String(rising.length)}>
          <small>
            {comparable.length
              ? `de ${plural(comparable.length, 'proveedor comparable', 'proveedores comparables')}`
              : 'Sin proveedores comparables'}
          </small>
        </Stat>
        <Stat label="Dejaron de venir" value={String(stopped.length)}>
          <small>Sin venir mucho más de lo habitual</small>
        </Stat>
      </div>
      <Panel
        title="Ranking por gasto"
        note="Compras netas de cada proveedor, su parte del gasto y cada cuántos días vino en promedio."
        table={{
          headers: [
            'Proveedor',
            'Compras netas',
            'Parte del gasto',
            'Tickets',
            'Ticket promedio',
            'Días con visita',
            'Periodo anterior',
          ],
          rows: current.map((x) => [
            x.company,
            pesos(x.net),
            percent(share(x.net)),
            String(x.tickets),
            pesos(x.avg),
            String(x.days),
            pesos(x.before),
          ]),
        }}
      >
        {current.length ? (
          <>
            <Rows
              items={ranked.map((x) => ({
                key: x.id,
                label: x.company,
                sub: `${percent(share(x.net))} del gasto · ${plural(x.tickets, 'ticket', 'tickets')} de ${pesos(x.avg)} · ${frequency(x)}`,
                value: x.net,
                text: pesos(x.net),
              }))}
            />
            {current.length > RANKED && (
              <button className="secondary rp-more" onClick={() => setAll(!all)}>
                {all ? `Ver los ${RANKED} principales` : `Ver todos (${current.length})`}
              </button>
            )}
          </>
        ) : (
          <Empty text="Ningún proveedor tuvo compras en este periodo." />
        )}
      </Panel>
      <Panel
        title="Por tipo de producto"
        note="Gasto neto agrupado por el tipo de producto del directorio de proveedores."
      >
        {byType.length ? (
          <Rows
            items={byType.map((t) => ({
              key: t.label,
              label: t.label,
              sub: `${percent(share(t.net))} del gasto · ${plural(t.suppliers, 'proveedor', 'proveedores')}`,
              value: t.net,
              text: pesos(t.net),
            }))}
          />
        ) : (
          <Empty text="Sin compras en el periodo." />
        )}
        {types.has('sin tipo') && (
          <p className="rp-note">
            Para separar «Sin tipo», completa el tipo de producto en el directorio de Caja
            proveedores.
          </p>
        )}
      </Panel>
      <Panel
        title="Ticket promedio al alza"
        note={`Proveedores cuyo ticket promedio subió ${percent(RISE, 0)} o más contra el periodo anterior. Puede ser aumento de precios o pedidos más grandes: revisa sus tickets en Reportes.`}
      >
        {rising.length ? (
          <Table
            headers={['Proveedor', 'Ticket promedio', 'Antes', 'Cambio', 'Tickets (antes)']}
            rows={rising.map((x) => ({
              key: x.id,
              cells: [
                x.company,
                pesos(x.avg),
                pesos(x.avgBefore),
                <span className="badge amber-badge">Sube {percent(x.change)}</span>,
                `${x.tickets} (${x.previous_tickets})`,
              ],
            }))}
          />
        ) : (
          <Empty
            text={
              comparable.length
                ? 'Ningún ticket promedio subió 10% o más.'
                : 'Hace falta que un proveedor tenga al menos dos tickets en cada periodo para compararlo.'
            }
          />
        )}
      </Panel>
      <Panel
        title="Dejaron de venir"
        note="Proveedores que llevan sin venir al menos tres veces lo que solían tardar entre visitas (y como mínimo una semana), contando este periodo y el anterior."
      >
        {stopped.length ? (
          <Table
            headers={['Proveedor', 'Última visita', 'Venía', 'Compras en ambos periodos']}
            rows={stopped.map((x) => ({
              key: x.id,
              cells: [
                <>
                  {x.company}
                  {!x.active && <span className="badge muted-badge mt-inline">Inactivo</span>}
                </>,
                `${shortDate(x.last_visit)} · hace ${plural(x.away, 'día', 'días')}`,
                x.usual <= 1.05
                  ? 'Diario'
                  : `Cada ${x.usual.toLocaleString('es-MX', { maximumFractionDigits: 1 })} días`,
                pesos(x.total),
              ],
            }))}
          />
        ) : (
          <Empty text="Todos los proveedores siguen viniendo con su frecuencia habitual." />
        )}
      </Panel>
    </>
  );
}

// A cut difference reads as what happened to the cash.
const gap = (cents: number) =>
  !cents ? 'Sin diferencia' : `${cents < 0 ? 'Faltan' : 'Sobran'} ${pesos(Math.abs(cents))}`;
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
// On time: scheduled shifts that already ended, minus absences and late arrivals.
const onTime = (p: any) => ratio(Math.max(0, p.scheduled - p.absences - p.late), p.scheduled);
// Done against what could still be done: today's pending tasks don't count yet.
const taskRate = (p: any) => ratio(p.tasks_done, p.tasks_done + p.tasks_missed);
const hoursText = (n: number) => `${n.toLocaleString('es-MX', { maximumFractionDigits: 1 })} h`;
// Fewer hours than this in a register say little about a person's sales per hour.
const MIN_RATE_HOURS = 8;

function EmployeeMetrics({ m }: { m: any }) {
  const e = m.employees,
    t = e.totals,
    p = e.previous.totals;
  const people: any[] = e.people;
  if (!people.length)
    return (
      <section className="card mt-panel">
        <Empty text="No hay horarios, entradas, tareas ni cortes en este periodo." />
      </section>
    );
  const punctual = onTime(t),
    punctualBefore = onTime(p);
  const tasksNow = taskRate(t),
    tasksBefore = taskRate(p);
  const hoursNow = ratio(t.hours, t.scheduled_hours);
  const scheduled = people.filter((x) => x.scheduled > 0);
  const withTasks = people.filter((x) => x.tasks_done + x.tasks_missed > 0);
  const cashiers = people.filter((x) => x.cuts > 0 || x.missing_cut > 0);
  const rated = people
    .filter((x) => x.rate_hours >= MIN_RATE_HOURS && num(x.rate_expected_cents) > 0)
    .map((x) => ({
      ...x,
      perHour: num(x.rate_sales_cents) / x.rate_hours,
      index: num(x.rate_sales_cents) / num(x.rate_expected_cents) - 1,
    }))
    .sort((a, b) => b.index - a.index);
  const name = (x: any) => (
    <>
      {x.employee}
      {x.deleted && <span className="badge muted-badge mt-inline">Eliminado</span>}
    </>
  );
  const shiftRates = (e.shift_rates as any[])
    .filter((r) => r.hours > 0)
    .map((r) => `${r.label.toLowerCase()} ${pesos(num(r.sales_cents) / r.hours)} por hora`)
    .join(' · ');
  return (
    <>
      <div className="mt-stats">
        <Stat label="Turnos a tiempo" value={punctual == null ? '—' : percent(punctual)}>
          {punctual != null && punctualBefore != null ? (
            <Change now={punctual} before={punctualBefore} points />
          ) : (
            <small>{plural(t.scheduled, 'turno programado', 'turnos programados')}</small>
          )}
        </Stat>
        <Stat label="Horas trabajadas" value={hoursText(t.hours)}>
          <small>
            {hoursNow == null
              ? 'Sin horarios terminados'
              : `${percent(hoursNow, 0)} de ${hoursText(t.scheduled_hours)} programadas`}
          </small>
        </Stat>
        <Stat label="Tareas cumplidas" value={tasksNow == null ? '—' : percent(tasksNow)}>
          {tasksNow != null && tasksBefore != null ? (
            <Change now={tasksNow} before={tasksBefore} points />
          ) : (
            <small>{plural(t.tasks_missed, 'tarea no realizada', 'tareas no realizadas')}</small>
          )}
        </Stat>
        <Stat label="Diferencia en cortes" value={gap(num(t.difference_cents))}>
          <small>
            {plural(t.cuts_uneven, 'corte', 'cortes')} con diferencia de {t.cuts} ·{' '}
            {plural(t.missing_cut, 'turno sin corte', 'turnos sin corte')}
          </small>
        </Stat>
      </div>
      <Panel
        title="Puntualidad"
        note="Turnos programados que ya terminaron y en los que la persona llegó a tiempo. Primero quien tuvo más incidencias."
        table={{
          headers: ['Persona', 'A tiempo', 'Turnos', 'Retardos', 'Faltas', 'Salidas anticipadas'],
          rows: scheduled.map((x) => [
            x.employee,
            percent(onTime(x)!),
            String(x.scheduled),
            String(x.late),
            String(x.absences),
            String(x.early_exit),
          ]),
        }}
      >
        {scheduled.length ? (
          <Rows
            items={[...scheduled]
              .sort((a, b) => onTime(a)! - onTime(b)! || b.early_exit - a.early_exit)
              .map((x) => ({
                key: x.user_id,
                label: x.employee,
                sub: [
                  plural(x.scheduled, 'turno', 'turnos'),
                  x.late && plural(x.late, 'retardo', 'retardos'),
                  x.absences && plural(x.absences, 'falta', 'faltas'),
                  x.early_exit && plural(x.early_exit, 'salida anticipada', 'salidas anticipadas'),
                ]
                  .filter(Boolean)
                  .join(' · '),
                value: onTime(x)!,
                text: `${percent(onTime(x)!, 0)} a tiempo`,
              }))}
            scale={1}
          />
        ) : (
          <Empty text="Nadie tuvo horario terminado en este periodo." />
        )}
      </Panel>
      <Panel
        title="Horas trabajadas contra programadas"
        note="Horas de las entradas ya cerradas contra las de los horarios que ya terminaron. Las horas de más pueden ser dobles turnos o entradas sin horario."
      >
        <Table
          headers={['Persona', 'Programadas', 'Trabajadas', 'Diferencia', 'Días trabajados']}
          rows={people
            .filter((x) => x.hours > 0 || x.scheduled_hours > 0)
            .map((x) => ({
              key: x.user_id,
              cells: [
                name(x),
                hoursText(x.scheduled_hours),
                <>
                  {hoursText(x.hours)}
                  {x.open > 0 && <span className="badge muted-badge mt-inline">En curso</span>}
                </>,
                `${x.hours - x.scheduled_hours >= 0 ? '+' : '−'}${hoursText(Math.abs(x.hours - x.scheduled_hours))}`,
                String(x.days),
              ],
            }))}
        />
      </Panel>
      <Panel
        title="Tareas cumplidas"
        note="Tareas realizadas contra las que ya no se pueden hacer; las de hoy aún pendientes no cuentan. Primero quien cumplió menos."
        table={{
          headers: ['Persona', 'Cumplidas', 'Realizadas', 'No realizadas', 'Pendientes de hoy'],
          rows: withTasks.map((x) => [
            x.employee,
            percent(taskRate(x)!),
            String(x.tasks_done),
            String(x.tasks_missed),
            String(x.tasks - x.tasks_done - x.tasks_missed),
          ]),
        }}
      >
        {withTasks.length ? (
          <Rows
            items={[...withTasks]
              .sort((a, b) => taskRate(a)! - taskRate(b)! || b.tasks_missed - a.tasks_missed)
              .map((x) => ({
                key: x.user_id,
                label: x.employee,
                sub: `${x.tasks_done} de ${x.tasks_done + x.tasks_missed} · ${plural(x.tasks_missed, 'no realizada', 'no realizadas')}`,
                value: taskRate(x)!,
                text: percent(taskRate(x)!, 0),
              }))}
            scale={1}
          />
        ) : (
          <Empty text="No hubo tareas que vencieran en este periodo." />
        )}
      </Panel>
      <Panel
        title="Precisión de cortes"
        note="Diferencia entre lo contado y lo esperado en los cortes de cada persona. Una diferencia pequeña que se repite pesa más que una grande aislada."
      >
        {cashiers.length ? (
          <Table
            headers={[
              'Persona',
              'Cortes',
              'Con diferencia',
              'Diferencia promedio',
              'Acumulado',
              'Turnos sin corte',
            ]}
            rows={[...cashiers]
              .sort((a, b) => num(b.abs_difference_cents) - num(a.abs_difference_cents))
              .map((x) => ({
                key: x.user_id,
                cells: [
                  name(x),
                  String(x.cuts),
                  String(x.cuts_uneven),
                  x.cuts ? pesos(num(x.abs_difference_cents) / x.cuts) : '—',
                  num(x.difference_cents) ? (
                    <span
                      className={`badge ${num(x.difference_cents) < 0 ? 'danger-badge' : 'amber-badge'}`}
                    >
                      {gap(num(x.difference_cents))}
                    </span>
                  ) : (
                    'Sin diferencia'
                  ),
                  x.missing_cut ? <span className="badge amber-badge">{x.missing_cut}</span> : '0',
                ],
              }))}
          />
        ) : (
          <Empty text="No hubo cortes en este periodo." />
        )}
      </Panel>
      <Panel
        title="Venta por hora trabajada"
        note={`Lo vendido en cada corte entre las horas de la entrada que cerró, comparado con el promedio de su mismo turno (${shiftRates || 'sin datos'}). Quien es el único en su turno no tiene con quién compararse. Solo personas con al menos ${MIN_RATE_HOURS} horas en caja. Depende también de la caja y del día: úsalo como referencia, no como calificación.`}
      >
        {rated.length ? (
          <Table
            headers={['Persona', 'Vendido', 'Horas en caja', 'Venta por hora', 'Contra su turno']}
            rows={rated.map((x) => ({
              key: x.user_id,
              cells: [
                name(x),
                pesos(num(x.rate_sales_cents)),
                hoursText(x.rate_hours),
                pesos(x.perHour),
                x.rate_alone
                  ? 'Único en su turno'
                  : Math.abs(x.index) < 0.005
                    ? 'Igual al promedio'
                    : `${x.index > 0 ? 'Arriba' : 'Abajo'} ${percent(Math.abs(x.index))}`,
              ],
            }))}
          />
        ) : (
          <Empty
            text={`Nadie tiene ${MIN_RATE_HOURS} horas o más en caja con corte ligado a su entrada en este periodo.`}
          />
        )}
      </Panel>
    </>
  );
}

// Rentabilidad: what came in from sales minus what went out to suppliers and extraordinary
// expenses. Cash flow, not profit: payroll, rent and inventory are not here.
function ProfitMetrics({ m, grain }: { m: any; grain: Grain }) {
  const sales = num(m.sales.totals.sales_cents),
    salesBefore = num(m.sales.previous.totals.sales_cents);
  const bought = num(m.purchases.totals.net_cents),
    boughtBefore = num(m.purchases.previous.totals.net_cents);
  const spent = num(m.expenses.totals.amount_cents),
    spentBefore = num(m.expenses.previous.totals.amount_cents);
  const result = sales - bought - spent,
    resultBefore = salesBefore - boughtBefore - spentBefore;
  const hadBefore = salesBefore > 0 || boughtBefore > 0 || spentBefore > 0;
  const margin = sales ? result / sales : null,
    marginBefore = salesBefore ? resultBefore / salesBefore : null;
  const grainName = { day: 'día', week: 'semana', month: 'mes' }[grain];
  const pick = (field: string) => (r: any) => ({ [field]: num(r[field]) });
  const series = [
    trend(m, m.sales.by_day, m.sales.previous.by_day, grain, pick('sales_cents')),
    trend(m, m.purchases.by_day, m.purchases.previous.by_day, grain, pick('net_cents')),
    trend(m, m.expenses.by_day, m.expenses.previous.by_day, grain, pick('amount_cents')),
  ];
  const bars: Bar[] = series[0].map(({ key }, i) => {
    const [s, p, x] = series.map((list) => list[i]);
    const now = (s.now?.sales_cents ?? 0) - (p.now?.net_cents ?? 0) - (x.now?.amount_cents ?? 0);
    const any = s.before || p.before || x.before;
    const before =
      (s.before?.sales_cents ?? 0) - (p.before?.net_cents ?? 0) - (x.before?.amount_cents ?? 0);
    const sold = s.now?.sales_cents ?? 0;
    return {
      key,
      label: bucketLabel(key, grain),
      title: bucketTitle(key, grain, m.range.from, m.range.to),
      value: now,
      // A stretch without any record is a gap in the line, not a zero.
      previous: any ? before : null,
      tip: [
        ['Ventas', pesos(sold)],
        ['Compras', pesos(p.now?.net_cents ?? 0)],
        ['Gastos extraordinarios', pesos(x.now?.amount_cents ?? 0)],
        ['Resultado', pesos(now)],
        ['Margen', sold ? percent(now / sold) : 'Sin ventas'],
      ],
    };
  });
  if (!sales && !bought && !spent)
    return (
      <section className="card mt-panel">
        <Empty text="No hay cortes, compras ni gastos extraordinarios en este periodo." />
      </section>
    );
  const entries: any[] = m.expenses.entries;
  return (
    <>
      <div className="mt-stats">
        <Stat label="Resultado de caja" value={pesos(result)}>
          {hadBefore ? (
            <Change now={result} before={resultBefore} />
          ) : (
            <small className="mt-change">Sin datos del periodo anterior</small>
          )}
        </Stat>
        <Stat label="Margen sobre ventas" value={margin == null ? 'Sin ventas' : percent(margin)}>
          {margin != null && marginBefore != null ? (
            <Change now={margin} before={marginBefore} points />
          ) : (
            <small className="mt-change">Sin ventas del periodo anterior</small>
          )}
        </Stat>
        <Stat label="Entró por ventas" value={pesos(sales)}>
          <Change now={sales} before={salesBefore} />
        </Stat>
        <Stat label="Salió" value={pesos(bought + spent)}>
          <small>
            {pesos(bought)} a proveedores · {pesos(spent)} en gastos extraordinarios
          </small>
        </Stat>
      </div>
      <p className="rp-note mt-caveat">
        Es flujo de efectivo, no utilidad: no incluye nómina, renta, servicios ni el valor del
        inventario, salvo lo que se haya registrado como gasto extraordinario en Caja general.
      </p>
      <Panel
        title={`Resultado por ${grainName}`}
        note="Ventas menos compras a proveedores y gastos extraordinarios. La línea punteada es el periodo anterior."
        legend={[
          { label: 'Este periodo' },
          ...(bars.some((b) => (b.value ?? 0) < 0)
            ? [{ label: 'Salió más de lo que entró', negative: true }]
            : []),
          { label: 'Periodo anterior', dashed: true },
        ]}
        table={{
          headers: [
            'Periodo',
            'Ventas',
            'Compras',
            'Gastos extraordinarios',
            'Resultado',
            'Margen',
          ],
          rows: bars.map((b) => [b.title, ...b.tip.map(([, v]) => v)]),
        }}
      >
        <BarChart bars={bars} axis={compact} />
      </Panel>
      <Panel
        title="De cada $100 vendidos"
        note="A dónde se fue lo que entró por ventas en el periodo."
      >
        {sales > 0 ? (
          <Rows
            scale={sales}
            items={[
              {
                key: 'compras',
                label: 'Compras a proveedores',
                sub: `${plural(m.purchases.totals.tickets, 'ticket', 'tickets')}`,
                value: bought,
                text: `${percent(bought / sales)} · ${pesos(bought)}`,
              },
              {
                key: 'gastos',
                label: 'Gastos extraordinarios',
                sub: plural(m.expenses.totals.entries, 'gasto', 'gastos'),
                value: spent,
                text: `${percent(spent / sales)} · ${pesos(spent)}`,
              },
              {
                key: 'queda',
                label: result >= 0 ? 'Queda' : 'Falta para cubrir las salidas',
                value: Math.abs(result),
                text: `${percent(Math.abs(result) / sales)} · ${pesos(Math.abs(result))}`,
              },
            ]}
          />
        ) : (
          <Empty text="No hay cortes de ventas en el periodo para calcular la proporción." />
        )}
      </Panel>
      <Panel
        title="Gastos extraordinarios"
        note="Salidas registradas en Caja general como gasto extraordinario."
      >
        {entries.length ? (
          <Table
            headers={['Fecha', 'Concepto', 'Registró', 'Importe']}
            rows={entries.map((x) => ({
              key: x.id,
              cells: [shortDate(x.date), x.note, x.employee, pesos(num(x.amount_cents))],
            }))}
          />
        ) : (
          <Empty text="No hubo gastos extraordinarios en el periodo." />
        )}
      </Panel>
    </>
  );
}

// Counts against what was expected: sales cuts plus supplier cash closes.
type Counts = {
  counts: number;
  short: number;
  short_cents: string;
  over: number;
  over_cents: string;
};
const joinCounts = (...list: Counts[]) => ({
  counts: list.reduce((s, c) => s + c.counts, 0),
  short: list.reduce((s, c) => s + c.short, 0),
  shortCents: list.reduce((s, c) => s + num(c.short_cents), 0),
  over: list.reduce((s, c) => s + c.over, 0),
  overCents: list.reduce((s, c) => s + num(c.over_cents), 0),
});
// Repeated shortages: at least three, in a quarter or more of a person's counts.
const PATTERN_COUNT = 3,
  PATTERN_SHARE = 0.25;
const adjustmentKinds: Record<string, string> = {
  cash_adjustment: 'Ajuste de efectivo',
  bank_adjustment: 'Ajuste de banco',
};

// Control de efectivo: where the cash came up short or over, and whether it repeats.
function CashMetrics({ m, grain }: { m: any; grain: Grain }) {
  const c = m.cash;
  const all = joinCounts(c.totals.cut, c.totals.supplier),
    before = joinCounts(c.previous.totals.cut, c.previous.totals.supplier);
  const share = all.counts ? all.short / all.counts : null,
    shareBefore = before.counts ? before.short / before.counts : null;
  const grainName = { day: 'día', week: 'semana', month: 'mes' }[grain];
  const series = trend(m, c.by_day, [], grain, (r) => ({
    short: num(r.short_cents),
    over: num(r.over_cents),
    shortN: r.short,
    counts: r.counts,
  }));
  const bars: Bar[] = series.map(({ key, now }) => ({
    key,
    label: bucketLabel(key, grain),
    title: bucketTitle(key, grain, m.range.from, m.range.to),
    value: now?.over ?? 0,
    below: now?.short ?? 0,
    tip: [
      ['Faltantes', pesos(now?.short ?? 0)],
      ['Sobrantes', pesos(now?.over ?? 0)],
      ['Conteos con faltante', `${now?.shortN ?? 0} de ${now?.counts ?? 0}`],
    ],
  }));
  const people = (c.by_person as any[])
    .map((p) => ({ ...p, all: joinCounts(p.cut, p.supplier) }))
    .sort((a, b) => b.all.shortCents - a.all.shortCents || b.all.short - a.all.short);
  const pattern = (x: ReturnType<typeof joinCounts>) =>
    x.short >= PATTERN_COUNT && x.short / x.counts >= PATTERN_SHARE;
  const flagged = people.filter((p) => pattern(p.all)).length;
  const place = (r: any) =>
    r.register === 'supplier' ? 'Caja de proveedores' : `Caja ${r.register}`;
  const summary = (x: ReturnType<typeof joinCounts>) =>
    `${plural(x.counts, 'conteo', 'conteos')} · ${x.short} con faltante · sobrantes ${pesos(x.overCents)}`;
  const adjustments: any[] = c.adjustments;
  if (!all.counts && !adjustments.length)
    return (
      <section className="card mt-panel">
        <Empty text="No hay cortes, cierres de caja de proveedores ni ajustes en este periodo." />
      </section>
    );
  return (
    <>
      <div className="mt-stats">
        <Stat label="Faltantes" value={pesos(all.shortCents)}>
          <Change now={all.shortCents} before={before.shortCents} upIs="bad" />
        </Stat>
        <Stat label="Sobrantes" value={pesos(all.overCents)}>
          <small>{plural(all.over, 'conteo con sobrante', 'conteos con sobrante')}</small>
        </Stat>
        <Stat label="Conteos con faltante" value={share == null ? '—' : percent(share)}>
          {share != null && shareBefore != null ? (
            <Change now={share} before={shareBefore} upIs="bad" points />
          ) : (
            <small>
              {all.short} de {plural(all.counts, 'conteo', 'conteos')}
            </small>
          )}
        </Stat>
        <Stat label="Faltantes repetidos" value={String(flagged)}>
          <small>
            {flagged === 1 ? 'persona' : 'personas'} con {PATTERN_COUNT} o más faltantes en al menos{' '}
            {percent(PATTERN_SHARE, 0)} de sus conteos
          </small>
        </Stat>
      </div>
      <p className="rp-note mt-caveat">
        Cuenta los cortes de ventas y los cierres de la caja de proveedores. Faltantes y sobrantes
        se muestran por separado: un sobrante no compensa un faltante.
      </p>
      <Panel
        title={`Faltantes y sobrantes por ${grainName}`}
        note="Hacia arriba lo que sobró; hacia abajo, en rojo, lo que faltó."
        legend={[{ label: 'Sobrantes' }, { label: 'Faltantes', negative: true }]}
        table={{
          headers: ['Periodo', 'Faltantes', 'Sobrantes', 'Conteos con faltante'],
          rows: bars.map((b) => [b.title, ...b.tip.map(([, v]) => v)]),
        }}
      >
        {all.shortCents || all.overCents ? (
          <BarChart bars={bars} axis={compact} />
        ) : (
          <Empty text="Todos los conteos del periodo cuadraron: sin faltantes ni sobrantes." />
        )}
      </Panel>
      <Panel
        title="Por persona"
        note="Cortes y cierres de caja de proveedores de cada persona. Primero quien acumula más faltantes."
      >
        {people.length ? (
          <Table
            headers={['Persona', 'Conteos', 'Con faltante', 'Faltantes', 'Sobrantes', 'Neto']}
            rows={people.map((p) => {
              const x = p.all,
                net = x.overCents - x.shortCents;
              return {
                key: p.user_id,
                cells: [
                  <>
                    {p.employee}
                    {p.deleted && <span className="badge muted-badge mt-inline">Eliminado</span>}
                    {pattern(x) && (
                      <span className="badge danger-badge mt-inline">Faltantes repetidos</span>
                    )}
                  </>,
                  p.supplier.counts
                    ? `${x.counts} (${p.supplier.counts} de proveedores)`
                    : String(x.counts),
                  x.counts ? `${x.short} · ${percent(x.short / x.counts, 0)}` : '—',
                  pesos(x.shortCents),
                  pesos(x.overCents),
                  gap(net),
                ],
              };
            })}
          />
        ) : (
          <Empty text="No hubo conteos en este periodo." />
        )}
      </Panel>
      <div className="mt-pair">
        <Panel title="Por caja" note="Faltantes acumulados en cada caja.">
          <Rows
            items={(c.by_register as any[]).map((r) => {
              const x = joinCounts(r);
              return {
                key: r.register,
                label: place(r),
                sub: summary(x),
                value: x.shortCents,
                text: x.shortCents ? `Faltan ${pesos(x.shortCents)}` : 'Sin faltantes',
              };
            })}
            danger
          />
        </Panel>
        <Panel title="Por turno" note="Faltantes acumulados en los cortes de cada turno.">
          {(c.by_shift as any[]).length ? (
            <Rows
              items={(c.by_shift as any[]).map((r) => {
                const x = joinCounts(r);
                return {
                  key: r.label,
                  label: `Turno ${r.label.toLowerCase()}`,
                  sub: summary(x),
                  value: x.shortCents,
                  text: x.shortCents ? `Faltan ${pesos(x.shortCents)}` : 'Sin faltantes',
                };
              })}
              danger
            />
          ) : (
            <Empty text="No hubo cortes en este periodo." />
          )}
        </Panel>
      </div>
      <Panel
        title="Ajustes manuales en Caja general"
        note="Efectivo o banco que se agregó o quitó a mano, sin un conteo detrás. Revisa que cada uno tenga explicación."
      >
        {adjustments.length ? (
          <Table
            headers={['Fecha', 'Tipo', 'Concepto', 'Registró', 'Efectivo', 'Banco']}
            rows={adjustments.map((a) => ({
              key: a.id,
              cells: [
                shortDate(a.date),
                adjustmentKinds[a.kind] ?? a.kind,
                a.note,
                a.employee,
                num(a.cash_cents) ? pesos(num(a.cash_cents)) : '—',
                num(a.bank_cents) ? pesos(num(a.bank_cents)) : '—',
              ],
            }))}
          />
        ) : (
          <Empty text="No hubo ajustes manuales en el periodo." />
        )}
      </Panel>
    </>
  );
}

// One indicator of the comparison: how to read it from a branch summary and which way is good.
type Indicator = {
  label: string;
  value: (x: any) => number | null;
  format: (v: number) => string;
  upIs: Tone;
  points?: boolean;
};
const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const indicators: Indicator[] = [
  { label: 'Ventas', value: (x) => num(x.sales_cents), format: pesos, upIs: 'good' },
  {
    label: 'Promedio por día con cortes',
    value: (x) => (x.sale_days ? num(x.sales_cents) / x.sale_days : null),
    format: pesos,
    upIs: 'good',
  },
  {
    label: 'Pagado con tarjeta',
    value: (x) => share(num(x.card_cents), num(x.sales_cents)),
    format: (v) => percent(v),
    upIs: 'neutral',
    points: true,
  },
  { label: 'Compras netas', value: (x) => num(x.purchases_cents), format: pesos, upIs: 'neutral' },
  {
    label: 'Compras sobre ventas',
    value: (x) => share(num(x.purchases_cents), num(x.sales_cents)),
    format: (v) => percent(v),
    upIs: 'bad',
    points: true,
  },
  {
    label: 'Gastos extraordinarios',
    value: (x) => num(x.expenses_cents),
    format: pesos,
    upIs: 'bad',
  },
  {
    label: 'Resultado de caja',
    value: (x) => num(x.sales_cents) - num(x.purchases_cents) - num(x.expenses_cents),
    format: pesos,
    upIs: 'good',
  },
  {
    label: 'Margen sobre ventas',
    value: (x) =>
      share(
        num(x.sales_cents) - num(x.purchases_cents) - num(x.expenses_cents),
        num(x.sales_cents),
      ),
    format: (v) => percent(v),
    upIs: 'good',
    points: true,
  },
  { label: 'Faltantes en conteos', value: (x) => num(x.short_cents), format: pesos, upIs: 'bad' },
  {
    label: 'Conteos con faltante',
    value: (x) => share(x.short_counts, x.counts),
    format: (v) => percent(v),
    upIs: 'bad',
    points: true,
  },
  {
    label: 'Turnos a tiempo',
    value: (x) => share(Math.max(0, x.scheduled - x.absences - x.late), x.scheduled),
    format: (v) => percent(v),
    upIs: 'good',
    points: true,
  },
  {
    label: 'Tareas cumplidas',
    value: (x) => share(x.tasks_done, x.tasks_done + x.tasks_missed),
    format: (v) => percent(v),
    upIs: 'good',
    points: true,
  },
];

// Comparación entre sucursales: the same figures side by side, each against its own past.
function BranchMetrics({ c, current }: { c: any; current: string }) {
  const list: any[] = c.branches;
  if (list.length < 2)
    return (
      <section className="card mt-panel">
        <Empty text="Hace falta más de una sucursal activa para comparar." />
      </section>
    );
  const result = (x: any) => num(x.sales_cents) - num(x.purchases_cents) - num(x.expenses_cents);
  return (
    <>
      <p className="rp-note mt-caveat">
        Todas las sucursales activas en el mismo periodo, cada una contra su propio periodo
        anterior. En cada indicador se resalta la mejor.
      </p>
      <Panel
        title="Lado a lado"
        note="Las mismas reglas de las demás pestañas, aplicadas a cada sucursal."
      >
        <Table
          headers={['Indicador', ...list.map((b) => b.name)]}
          rows={indicators.map((ind) => {
            const values = list.map((b) => ind.value(b.current));
            const known = values.filter((v): v is number => v != null);
            const best =
              ind.upIs === 'neutral' || known.length < 2 || new Set(known).size < 2
                ? null
                : ind.upIs === 'good'
                  ? Math.max(...known)
                  : Math.min(...known);
            return {
              key: ind.label,
              cells: [
                ind.label,
                ...list.map((b, i) => {
                  const v = values[i],
                    before = ind.value(b.previous);
                  if (v == null) return '—';
                  return (
                    <span className="mt-cell">
                      {v === best ? <strong>{ind.format(v)}</strong> : ind.format(v)}
                      {before != null && (
                        <Change now={v} before={before} upIs={ind.upIs} points={ind.points} brief />
                      )}
                    </span>
                  );
                }),
              ],
            };
          })}
        />
      </Panel>
      <div className="mt-pair">
        <Panel title="Ventas" note="Lo vendido en el periodo por sucursal.">
          <Rows
            items={list.map((b) => ({
              key: b.id,
              label: b.name,
              sub: `${plural(b.current.cuts, 'corte', 'cortes')}${b.id === current ? ' · sucursal actual' : ''}`,
              value: num(b.current.sales_cents),
              text: pesos(num(b.current.sales_cents)),
            }))}
          />
        </Panel>
        <Panel title="Resultado de caja" note="Ventas menos compras y gastos extraordinarios.">
          <Rows
            items={list.map((b) => ({
              key: b.id,
              label: b.name,
              sub: num(b.current.sales_cents)
                ? `Margen ${percent(result(b.current) / num(b.current.sales_cents))}`
                : 'Sin ventas',
              value: Math.max(0, result(b.current)),
              text: pesos(result(b.current)),
            }))}
          />
        </Panel>
      </div>
      <Panel title="Faltantes" note="Faltantes acumulados en cortes y cierres de proveedores.">
        <Rows
          danger
          items={list.map((b) => ({
            key: b.id,
            label: b.name,
            sub: `${b.current.short_counts} de ${plural(b.current.counts, 'conteo', 'conteos')} con faltante`,
            value: num(b.current.short_cents),
            text: num(b.current.short_cents)
              ? `Faltan ${pesos(num(b.current.short_cents))}`
              : 'Sin faltantes',
          }))}
        />
      </Panel>
    </>
  );
}

function PurchaseMetrics({ m, grain, days }: { m: any; grain: Grain; days: number }) {
  const c = m.purchases,
    t = c.totals,
    p = c.previous.totals;
  const net = num(t.net_cents),
    before = num(p.net_cents),
    sales = num(m.sales.totals.sales_cents),
    salesBefore = num(m.sales.previous.totals.sales_cents);
  const ratio = sales ? net / sales : null,
    ratioBefore = salesBefore ? before / salesBefore : null;
  const grainName = { day: 'día', week: 'semana', month: 'mes' }[grain];
  const series = trend(m, c.by_day, c.previous.by_day, grain, (r) => ({
    net: num(r.net_cents),
    tickets: r.tickets,
  }));
  const salesSeries = new Map(
    trend(m, m.sales.by_day, [], grain, (r) => ({ sales: num(r.sales_cents) })).map((x) => [
      x.key,
      x.now?.sales ?? 0,
    ]),
  );
  const bars: Bar[] = series.map(({ key, now, before }) => ({
    key,
    label: bucketLabel(key, grain),
    title: bucketTitle(key, grain, m.range.from, m.range.to),
    value: now?.net ?? 0,
    // A stretch without records is a gap in the line, not a zero.
    previous: before?.net ?? null,
    tip: [
      ['Compras netas', pesos(now?.net ?? 0)],
      ['Periodo anterior', before ? pesos(before.net) : 'Sin registros'],
      ['Tickets', String(now?.tickets ?? 0)],
    ],
  }));
  const shares: Bar[] = series.map(({ key, now }) => {
    const sold = salesSeries.get(key) ?? 0,
      spent = now?.net ?? 0;
    return {
      key,
      label: bucketLabel(key, grain),
      title: bucketTitle(key, grain, m.range.from, m.range.to),
      value: sold ? spent / sold : null,
      tip: sold
        ? [
            ['Compras / ventas', percent(spent / sold)],
            ['Compras netas', pesos(spent)],
            ['Ventas', pesos(sold)],
          ]
        : [
            ['Sin cortes de ventas', ''],
            ['Compras netas', pesos(spent)],
          ],
    };
  });
  const shareTop = niceMax(Math.max(0.1, ...shares.map((b) => b.value ?? 0)), 4).top;
  const week = weekdayRows(c.by_weekday, 'net_cents');
  if (!t.tickets && !t.voided && !t.corrections)
    return (
      <section className="card mt-panel">
        <Empty text="No hay tickets de proveedores en este periodo." />
      </section>
    );
  return (
    <>
      <div className="mt-stats">
        <Stat label="Compras netas" value={pesos(net)}>
          <Change now={net} before={before} upIs="neutral" />
          <Coverage now={t.days} before={p.days} what="compras" />
        </Stat>
        <Stat label="Compras sobre ventas" value={ratio == null ? 'Sin ventas' : percent(ratio)}>
          {ratio != null && ratioBefore != null ? (
            <Change now={ratio} before={ratioBefore} upIs="bad" points />
          ) : (
            <small className="mt-change">
              {ratio == null ? 'No hay cortes en el periodo' : 'Sin ventas del periodo anterior'}
            </small>
          )}
        </Stat>
        <Stat label="Promedio por día" value={pesos(t.days ? net / t.days : 0)}>
          <small>{plural(t.days, 'día con compras', 'días con compras')}</small>
        </Stat>
        <Stat label="Ticket promedio" value={pesos(t.tickets ? net / t.tickets : 0)}>
          <small>{plural(t.tickets, 'ticket', 'tickets')}</small>
        </Stat>
      </div>
      <Panel
        title={`Compras por ${grainName}`}
        note="Tickets de proveedores menos sus correcciones; los anulados no cuentan. La línea punteada es el periodo anterior."
        legend={[{ label: 'Este periodo' }, { label: 'Periodo anterior', dashed: true }]}
        table={{
          headers: ['Periodo', 'Compras netas', 'Periodo anterior', 'Tickets'],
          rows: bars.map((b) => [b.title, ...b.tip.map(([, v]) => v)]),
        }}
      >
        <BarChart bars={bars} axis={compact} />
      </Panel>
      <Panel
        title="Compras como porcentaje de las ventas"
        note={`De cada $100 vendidos en ${grain === 'week' ? 'la' : 'el'} ${grainName}, cuánto se pagó a proveedores. Es flujo de efectivo, no utilidad.`}
        table={{
          headers: ['Periodo', 'Compras / ventas', 'Compras netas', 'Ventas'],
          rows: shares.map((b) => [
            b.title,
            ...(b.value == null ? ['Sin cortes', b.tip[1][1], '—'] : b.tip.map(([, v]) => v)),
          ]),
        }}
      >
        <BarChart bars={shares} axis={(v) => percent(v, 0)} top={shareTop} />
      </Panel>
      <Panel
        title="Por día de la semana"
        note="Compra promedio de cada día de la semana, contando solo los días con tickets. Sirve para saber cuánto efectivo dejar en la caja de proveedores."
        table={{
          headers: ['Día', 'Compra promedio', 'Días con compras'],
          rows: week.map((w) => [w.full, pesos(w.avg), String(w.days)]),
        }}
      >
        <BarChart
          bars={week.map((w) => ({
            key: w.name,
            label: w.name,
            title: `Los ${w.full}`,
            value: w.avg,
            tip: [
              ['Compra promedio', pesos(w.avg)],
              ['Días con compras', String(w.days)],
            ],
          }))}
          axis={compact}
        />
      </Panel>
      <Panel
        title="Anulaciones y correcciones"
        note="Tickets anulados por quien los registró y correcciones hechas en el periodo."
      >
        <div className="mt-stats inner">
          <Stat label="Tickets anulados" value={String(t.voided)}>
            <small>{pesos(num(t.voided_cents))}</small>
          </Stat>
          <Stat label="Correcciones" value={String(t.corrections)}>
            <small>{pesos(num(t.corrections_cents))}</small>
          </Stat>
        </div>
        {c.by_person.length ? (
          <div className="table-wrap">
            <table className="rp-table mt-table">
              <thead>
                <tr>
                  <th>Persona</th>
                  <th>Anulados</th>
                  <th>Importe anulado</th>
                  <th>Correcciones</th>
                  <th>Importe corregido</th>
                </tr>
              </thead>
              <tbody>
                {c.by_person.map((r: any) => (
                  <tr key={r.user_id}>
                    <td data-label="Persona">{r.employee}</td>
                    <td data-label="Anulados">{r.voided}</td>
                    <td data-label="Importe anulado">{pesos(num(r.voided_cents))}</td>
                    <td data-label="Correcciones">{r.corrections}</td>
                    <td data-label="Importe corregido">{pesos(num(r.corrections_cents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="Sin anulaciones ni correcciones en el periodo." />
        )}
      </Panel>
      {days < 7 && (
        <p className="rp-note">
          Con menos de una semana, las comparaciones por día de la semana dicen poco: elige 30 o 90
          días.
        </p>
      )}
    </>
  );
}
