import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, Table2, BarChart3 } from 'lucide-react';
import { money } from '../../../packages/domain/index.js';
import { request } from './api';
import { addDays } from './ScheduleBoard';

// Métricas compara la sucursal elegida al iniciar sesión con el periodo anterior de igual
// duración. Reportes lista cada registro; aquí se ven tendencias.
type Tab = 'ventas' | 'compras';
const tabs: [Tab, string][] = [
  ['ventas', 'Ventas'],
  ['compras', 'Compras'],
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
  const v = cents / 100;
  if (Math.abs(v) >= 1_000_000)
    return `$${(v / 1_000_000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} M`;
  if (Math.abs(v) >= 1_000)
    return `$${(v / 1_000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} mil`;
  return `$${v.toLocaleString('es-MX', { maximumFractionDigits: 0 })}`;
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
}: {
  now: number;
  before: number;
  upIs?: Tone;
  points?: boolean;
}) {
  if (!points && !before)
    return <small className="mt-change">Sin datos del periodo anterior</small>;
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
      {flat ? 'Igual' : `${up ? 'Sube' : 'Baja'} ${amount}`} que el periodo anterior
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
  const values = bars.flatMap((b) => [b.value ?? 0, b.previous ?? 0]);
  const { top, step } = fixedTop
    ? { top: fixedTop, step: fixedTop / 4 }
    : niceMax(Math.max(0, ...values));
  const left = 58,
    right = 8,
    pad = 8,
    bottom = 24;
  const plot = Math.max(0, width - left - right);
  const band = bars.length ? plot / bars.length : 0;
  const barW = Math.max(1, Math.min(36, band - 2, band * 0.72));
  const y = (v: number) => pad + (height - pad - bottom) * (1 - Math.min(v, top) / top);
  const x = (i: number) => left + band * i + band / 2;
  // Labels thin out so they never collide.
  const labelWidth = Math.max(...bars.map((b) => b.label.length), 1) * 6.5 + 12;
  const every = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plot / labelWidth))));
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
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
            return (
              <g key={b.key} className={hover != null && hover !== i ? 'dim' : ''}>
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
}: {
  items: { key: string; label: string; sub?: string; value: number; text: string }[];
}) {
  const max = Math.max(0, ...items.map((i) => i.value));
  return (
    <ul className="mt-rows">
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
type Legend = { label: string; color?: string; dashed?: boolean };
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
                className={l.dashed ? 'dashed' : ''}
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
}: {
  branchId: string;
  branchName: string;
  today: string;
}) {
  const [tab, setTab] = useState<Tab>('ventas'),
    [preset, setPreset] = useState<Preset>('30'),
    [custom, setCustom] = useState<[string, string]>([addDays(today, -29), today]),
    [chosenGrain, setGrain] = useState<Grain | null>(null),
    [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
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
          {tabs.map(([key, text]) => (
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
      </div>
      <p className="rp-context">
        {branchName} ·{' '}
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
