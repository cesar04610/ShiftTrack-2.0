import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Download,
  Landmark,
  PackageX,
  Search,
  ShieldCheck,
  ShoppingBag,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { money, auditActions as actions, treasuryKinds } from '../../../packages/domain/index.js';
import { request, download, imageUrl } from './api';
import { addDays } from './ScheduleBoard';

// Reports always cover the branch picked at sign-in; only the period changes here.
// The screen opens on a short summary; every topic keeps its detail one tap away.
type Key =
  | 'ventas'
  | 'gastos'
  | 'proveedores'
  | 'general'
  | 'personal'
  | 'tareas'
  | 'faltantes'
  | 'auditoria';
const sections: Record<Key, { title: string; about: string; icon: LucideIcon }> = {
  ventas: {
    title: 'Ventas y cortes',
    about: 'Lo que se vendió y cómo cerró cada caja.',
    icon: Banknote,
  },
  gastos: {
    title: 'Gastos a proveedores',
    about: 'Compras y pagos, por proveedor, día o ticket.',
    icon: ShoppingBag,
  },
  proveedores: {
    title: 'Caja de proveedores',
    about: 'Apertura, lo esperado y lo contado en cada turno.',
    icon: Wallet,
  },
  general: {
    title: 'Caja general',
    about: 'Entradas y salidas de efectivo y banco.',
    icon: Landmark,
  },
  personal: {
    title: 'Personal',
    about: 'Horas, asistencia, faltas e incidencias.',
    icon: Users,
  },
  tareas: {
    title: 'Tareas',
    about: 'Lo que se cumplió y lo que quedó sin hacer.',
    icon: ClipboardCheck,
  },
  faltantes: {
    title: 'Faltantes',
    about: 'Productos reportados como faltantes.',
    icon: PackageX,
  },
  auditoria: {
    title: 'Auditoría',
    about: 'Cada operación: quién la hizo y cuándo.',
    icon: ShieldCheck,
  },
};
// Where a shortcut lands inside a section: its view and its filter.
type Target = { view?: string; filter?: string };

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'last-month' | 'custom';
const presets: [Preset, string][] = [
  ['today', 'Hoy'],
  ['yesterday', 'Ayer'],
  ['week', '7 días'],
  ['month', 'Este mes'],
  ['last-month', 'Mes pasado'],
  ['custom', 'Otro'],
];
function period(preset: Preset, today: string): [string, string] {
  const monthStart = `${today.slice(0, 8)}01`;
  if (preset === 'yesterday') return [addDays(today, -1), addDays(today, -1)];
  if (preset === 'week') return [addDays(today, -6), today];
  if (preset === 'month') return [monthStart, today];
  if (preset === 'last-month') {
    const end = addDays(monthStart, -1);
    return [`${end.slice(0, 8)}01`, end];
  }
  return [today, today];
}
const incidentNames: Record<string, string> = {
  late: 'Retardo',
  early_exit: 'Salida anticipada',
  missing_cut: 'Sin corte',
};

function when(value: string | null, zone: string, withDate = true) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(
    'es-MX',
    withDate
      ? { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }
      : { timeZone: zone, timeStyle: 'short' },
  ).format(new Date(value));
}
function shortDate(date: string) {
  return new Intl.DateTimeFormat('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
}
const hours = (n: number) => `${n.toLocaleString('es-MX', { maximumFractionDigits: 1 })} h`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const signed = (cents: string | bigint) => (BigInt(cents) > 0n ? `+${money(cents)}` : money(cents));
const abs = (cents: string | bigint) => money(BigInt(cents) < 0n ? -BigInt(cents) : BigInt(cents));
// A difference reads as what happened to the cash: «faltan $50», not «-$50.00».
const gap = (cents: string | bigint) =>
  BigInt(cents) === 0n
    ? 'Sin diferencia'
    : `${BigInt(cents) < 0n ? 'Faltan' : 'Sobran'} ${abs(cents)}`;

const tones = { warn: ' amber-badge', muted: ' muted-badge', danger: ' danger-badge' };
const Pill = ({ children, tone }: { children: ReactNode; tone?: 'warn' | 'muted' | 'danger' }) => (
  <span className={`badge${tone ? tones[tone] : ''}`}>{children}</span>
);
const Difference = ({ cents }: { cents: string | null }) =>
  cents == null ? (
    <>—</>
  ) : BigInt(cents) === 0n ? (
    <span className="rp-ok">Sin diferencia</span>
  ) : (
    <Pill tone={BigInt(cents) < 0n ? 'danger' : 'warn'}>{gap(cents)}</Pill>
  );

// The few numbers that summarize a section, in one quiet strip.
function Facts({
  items,
}: {
  items: { label: string; value: string; foot?: string; warn?: boolean }[];
}) {
  return (
    <div className="rp-facts">
      {items.map((f) => (
        <div key={f.label} className={f.warn ? 'warn' : ''}>
          <span>{f.label}</span>
          <strong>{f.value}</strong>
          {f.foot && <small>{f.foot}</small>}
        </div>
      ))}
    </div>
  );
}
// One list at a time: the options double as filters and show how many records each holds.
function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [string, string, number?][];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="rp-choice" role="group" aria-label={label}>
      {options.map(([key, text, count]) => (
        <button
          key={key}
          className={value === key ? 'selected' : ''}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {text}
          {count != null && <span>{count}</span>}
        </button>
      ))}
    </div>
  );
}
const STEP = 15;
type Row = { key: string; cells: ReactNode[]; text: string };
// A table that shows a first batch, searches every cell and stacks into cards on a phone.
function Grid({
  headers,
  rows,
  empty,
  footer,
  tools,
}: {
  headers: string[];
  rows: Row[];
  empty: string;
  footer?: ReactNode[];
  tools?: ReactNode;
}) {
  const [query, setQuery] = useState(''),
    [limit, setLimit] = useState(STEP);
  const needle = query.trim().toLowerCase();
  const found = needle ? rows.filter((r) => r.text.toLowerCase().includes(needle)) : rows;
  const shown = found.slice(0, limit);
  const searchable = rows.length > 8;
  return (
    <>
      {(tools || searchable) && (
        <div className="rp-tools">
          {tools}
          {searchable && (
            <label className="rp-search">
              <Search size={14} />
              <input
                type="search"
                placeholder="Buscar…"
                aria-label="Buscar en la lista"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setLimit(STEP);
                }}
              />
            </label>
          )}
        </div>
      )}
      {!found.length ? (
        <div className="empty">
          <ClipboardCheck size={30} />
          <p>{needle ? `Sin resultados para «${query.trim()}».` : empty}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="rp-table">
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  {r.cells.map((c, i) => (
                    <td key={i} data-label={headers[i]}>
                      <div>{c}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footer && !needle && (
              <tfoot>
                <tr>
                  {footer.map((c, i) => (
                    <td key={i} data-label={headers[i]}>
                      {c}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {found.length > shown.length && (
        <button className="secondary rp-more" onClick={() => setLimit(limit + STEP * 2)}>
          Ver más ({found.length - shown.length} restantes)
        </button>
      )}
    </>
  );
}
// Ranked bars: enough to compare suppliers or days without a chart library.
function Ranking({
  items,
  empty,
}: {
  items: { key: string; label: string; sub?: string; value: bigint }[];
  empty: string;
}) {
  const max = items.reduce((m, i) => (i.value > m ? i.value : m), 0n);
  if (!items.length)
    return (
      <div className="empty">
        <ClipboardCheck size={30} />
        <p>{empty}</p>
      </div>
    );
  return (
    <ul className="rp-ranking">
      {items.map((i) => (
        <li key={i.key}>
          <div>
            <strong>{i.label}</strong>
            {i.sub && <small>{i.sub}</small>}
          </div>
          <span className="rp-track">
            <i
              style={{
                width: `${max > 0n && i.value > 0n ? Math.max(2, Number((i.value * 1000n) / max) / 10) : 0}%`,
              }}
            />
          </span>
          <b>{money(i.value)}</b>
        </li>
      ))}
    </ul>
  );
}

export default function Reports({
  branchId,
  branchName,
  zone,
  today,
  onError,
}: {
  branchId: string;
  branchName: string;
  zone: string;
  today: string;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState<{ key: Key; target: Target } | null>(null),
    [preset, setPreset] = useState<Preset>('today'),
    [custom, setCustom] = useState<[string, string]>([today, today]),
    [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [exporting, setExporting] = useState(false);
  const [from, to] = preset === 'custom' ? custom : period(preset, today);
  useEffect(() => {
    if (!from || !to || from > to) return;
    let current = true;
    setLoading(true);
    setError('');
    request(`/reports?branch_id=${branchId}&from=${from}&to=${to}`)
      .then((r) => current && setData(r))
      .catch((e) => current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [branchId, from, to]);
  const go = (key: Key, target: Target = {}) => {
    setOpen({ key, target });
    window.scrollTo({ top: 0 });
  };
  const label = from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  const section = open && sections[open.key];
  return (
    <div className="reports">
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
        <button
          className="secondary rp-export"
          disabled={exporting || !data}
          title="Descarga todo el periodo en un archivo de Excel"
          onClick={() => {
            setExporting(true);
            download(
              `/reports/export?branch_id=${branchId}&from=${from}&to=${to}`,
              `reportes-${from}-a-${to}.xlsx`,
            )
              .catch(onError)
              .finally(() => setExporting(false));
          }}
        >
          <Download size={15} /> {exporting ? 'Generando…' : 'Descargar Excel'}
        </button>
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
      <p className="rp-context">
        {branchName} · <strong>{label}</strong>
        {loading && data && <span> · Actualizando…</span>}
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!data ? (
        !error && <p className="rp-note">Cargando reportes…</p>
      ) : !open || !section ? (
        <Home r={data} go={go} />
      ) : (
        <section className="card rp-section">
          <header className="rp-section-head">
            <button className="rp-back" onClick={() => setOpen(null)}>
              <ArrowLeft size={15} /> Reportes
            </button>
            <div>
              <i>
                <section.icon size={18} />
              </i>
              <div>
                <h2>{section.title}</h2>
                <p>{section.about}</p>
              </div>
            </div>
          </header>
          {/* The key restarts a section when a shortcut asks for another view of it. */}
          <Fragment key={`${open.key}:${open.target.view}:${open.target.filter}`}>
            {open.key === 'ventas' && <Sales r={data.sales} target={open.target} />}
            {open.key === 'gastos' && (
              <Expenses r={data.expenses} zone={zone} target={open.target} />
            )}
            {open.key === 'proveedores' && <SupplierCash r={data.expenses} />}
            {open.key === 'general' && <Treasury r={data.treasury} zone={zone} />}
            {open.key === 'personal' && <Staff r={data.staff} zone={zone} target={open.target} />}
            {open.key === 'tareas' && (
              <Tasks
                r={data.operations}
                zone={zone}
                branchId={branchId}
                onError={onError}
                target={open.target}
              />
            )}
            {open.key === 'faltantes' && (
              <Shortages r={data.operations} zone={zone} target={open.target} />
            )}
            {open.key === 'auditoria' && (
              <Audit branchId={branchId} from={from} to={to} zone={zone} />
            )}
          </Fragment>
        </section>
      )}
    </div>
  );
}

// The opening view: what needs a look, and one door per topic.
function Home({ r, go }: { r: any; go: (key: Key, target?: Target) => void }) {
  const [all, setAll] = useState(false);
  const sales = r.sales.totals,
    spend = r.expenses.totals,
    staff = r.staff.totals,
    ops = r.operations.totals,
    cash = r.treasury.totals;
  const shifts: any[] = r.expenses.shifts;
  const uneven = shifts.filter((s) => s.difference_cents != null && BigInt(s.difference_cents));
  const noCut = r.staff.incidents.filter((i: any) => i.kind === 'missing_cut').length;
  const attention: { key: string; text: string; to: Key; target?: Target }[] = [];
  if (sales.with_difference)
    attention.push({
      key: 'cuts',
      text: `${plural(sales.with_difference, 'corte con diferencia', 'cortes con diferencia')} · ${gap(sales.difference_cents).toLowerCase()} en total`,
      to: 'ventas',
      target: { view: 'cuts', filter: 'uneven' },
    });
  if (uneven.length)
    attention.push({
      key: 'shifts',
      text: `Caja de proveedores: ${plural(uneven.length, 'turno con diferencia', 'turnos con diferencia')}`,
      to: 'proveedores',
    });
  if (noCut)
    attention.push({
      key: 'no-cut',
      text: plural(noCut, 'turno sin corte', 'turnos sin corte'),
      to: 'personal',
      target: { view: 'incidents' },
    });
  if (staff.absences)
    attention.push({
      key: 'absences',
      text: plural(staff.absences, 'falta', 'faltas'),
      to: 'personal',
      target: { view: 'incidents' },
    });
  if (staff.late || staff.early_exit)
    attention.push({
      key: 'late',
      text: [
        staff.late && plural(staff.late, 'retardo', 'retardos'),
        staff.early_exit && plural(staff.early_exit, 'salida anticipada', 'salidas anticipadas'),
      ]
        .filter(Boolean)
        .join(' y '),
      to: 'personal',
      target: { view: 'incidents' },
    });
  if (ops.tasks_missed)
    attention.push({
      key: 'tasks',
      text: plural(ops.tasks_missed, 'tarea no realizada', 'tareas no realizadas'),
      to: 'tareas',
      target: { filter: 'missed' },
    });
  if (ops.shortages_open)
    attention.push({
      key: 'shortages',
      text: plural(ops.shortages_open, 'faltante sin resolver', 'faltantes sin resolver'),
      to: 'faltantes',
      target: { filter: 'open' },
    });
  if (spend.voided)
    attention.push({
      key: 'voided',
      text: plural(spend.voided, 'ticket anulado', 'tickets anulados'),
      to: 'gastos',
      target: { view: 'tickets', filter: 'voided' },
    });
  const pendingTasks = ops.tasks - ops.tasks_done - ops.tasks_missed;
  const cards: { key: Key; value: string; foot: string }[] = [
    {
      key: 'ventas',
      value: money(sales.sales_cents),
      foot: sales.cuts
        ? `${plural(sales.cuts, 'corte', 'cortes')} · ${money(sales.card_cents)} con tarjeta`
        : 'Sin cortes en el periodo',
    },
    {
      key: 'gastos',
      value: money(spend.net_cents),
      foot: spend.tickets
        ? `${plural(spend.tickets, 'ticket', 'tickets')} · ${plural(r.expenses.by_supplier.length, 'proveedor', 'proveedores')}`
        : 'Sin compras en el periodo',
    },
    {
      key: 'proveedores',
      value: plural(shifts.length, 'turno', 'turnos'),
      foot: shifts.length ? gap(spend.shift_difference_cents) : 'Sin turnos en el periodo',
    },
    {
      key: 'general',
      value: plural(cash.entries, 'movimiento', 'movimientos'),
      foot: cash.entries
        ? `Efectivo ${signed(cash.cash_cents)} · Banco ${signed(cash.bank_cents)}`
        : 'Sin movimientos en el periodo',
    },
    {
      key: 'personal',
      value: hours(staff.hours),
      foot: `${plural(r.staff.people.length, 'persona', 'personas')} con actividad`,
    },
    {
      key: 'tareas',
      value: ops.tasks ? `${Math.round((ops.tasks_done / ops.tasks) * 100)}%` : '—',
      foot: ops.tasks
        ? `${ops.tasks_done} de ${ops.tasks} cumplidas${pendingTasks ? ` · ${pendingTasks} pendientes` : ''}`
        : 'Sin tareas en el periodo',
    },
    {
      key: 'faltantes',
      value: String(ops.shortages),
      foot: ops.shortages
        ? `${ops.shortages - ops.shortages_open} resueltos · ${ops.shortages_open} pendientes`
        : 'Sin faltantes reportados',
    },
    { key: 'auditoria', value: 'Bitácora', foot: 'Todas las operaciones registradas' },
  ];
  return (
    <>
      {attention.length ? (
        <section className="rp-attention" aria-label="Requiere tu atención">
          <h2>
            <AlertTriangle size={15} /> Requiere tu atención
          </h2>
          <ul>
            {(all ? attention : attention.slice(0, 4)).map((a) => (
              <li key={a.key}>
                <button onClick={() => go(a.to, a.target)}>
                  <span>{a.text}</span>
                  <ChevronRight size={15} />
                </button>
              </li>
            ))}
          </ul>
          {!all && attention.length > 4 && (
            <button className="rp-rest" onClick={() => setAll(true)}>
              Ver {attention.length - 4} más
            </button>
          )}
        </section>
      ) : (
        <p className="rp-calm">
          <CheckCircle2 size={16} /> Todo en orden: sin diferencias, faltas ni pendientes en este
          periodo.
        </p>
      )}
      <div className="rp-cards">
        {cards.map((c) => {
          const s = sections[c.key];
          return (
            <button key={c.key} className="rp-card" onClick={() => go(c.key)}>
              <span className="rp-card-top">
                <i>
                  <s.icon size={17} />
                </i>
                {s.title}
                <ChevronRight size={16} />
              </span>
              <strong>{c.value}</strong>
              <small>{c.foot}</small>
            </button>
          );
        })}
      </div>
    </>
  );
}

function Sales({ r, target }: { r: any; target: Target }) {
  const t = r.totals;
  const [view, setView] = useState(target.view || 'cuts'),
    [uneven, setUneven] = useState(target.filter === 'uneven');
  const cuts = uneven ? r.cuts.filter((c: any) => BigInt(c.difference_cents)) : r.cuts;
  return (
    <>
      <Facts
        items={[
          { label: 'Ventas', value: money(t.sales_cents), foot: plural(t.cuts, 'corte', 'cortes') },
          { label: 'Con tarjeta', value: money(t.card_cents) },
          { label: 'En efectivo', value: money(t.cash_cents) },
          {
            label: 'Diferencia en cortes',
            value: gap(t.difference_cents),
            foot: t.with_difference
              ? plural(t.with_difference, 'corte no cuadró', 'cortes no cuadraron')
              : undefined,
            warn: !!t.with_difference,
          },
        ]}
      />
      <Choice
        label="Vista"
        value={view}
        onChange={setView}
        options={[
          ['cuts', 'Cortes', r.cuts.length],
          ['days', 'Ventas por día'],
        ]}
      />
      {view === 'days' ? (
        <Ranking
          empty="Sin ventas en este periodo."
          items={r.by_day.map((d: any) => ({
            key: d.date,
            label: shortDate(d.date),
            sub: plural(d.cuts, 'corte', 'cortes'),
            value: BigInt(d.sales_cents),
          }))}
        />
      ) : (
        <Grid
          empty={uneven ? 'Ningún corte con diferencia.' : 'Sin cortes en este periodo.'}
          tools={
            <label className="rp-check">
              <input
                type="checkbox"
                checked={uneven}
                onChange={(e) => setUneven(e.target.checked)}
              />
              Solo con diferencia
            </label>
          }
          headers={['Fecha', 'Responsable', 'Ventas', 'Tarjeta', 'Efectivo contado', 'Diferencia']}
          rows={cuts.map((c: any) => ({
            key: c.id,
            text: `${c.employee} caja ${c.register_number} ${c.label} ${c.note}`,
            cells: [
              shortDate(c.date),
              <>
                <strong>{c.employee}</strong>
                <small className="rp-sub">
                  Caja {c.register_number}
                  {c.label ? ` · ${c.label}` : ''}
                </small>
                {c.note && <small className="rp-sub">«{c.note}»</small>}
              </>,
              money(c.sales_cents),
              money(c.card_cents),
              <>
                {money(c.declared_cents)}
                <small className="rp-sub">esperado {money(c.expected_cents)}</small>
              </>,
              <Difference cents={c.difference_cents} />,
            ],
          }))}
        />
      )}
    </>
  );
}

function Expenses({ r, zone, target }: { r: any; zone: string; target: Target }) {
  const t = r.totals;
  const [view, setView] = useState(target.view || 'suppliers'),
    [voided, setVoided] = useState(target.filter === 'voided');
  const tickets = voided ? r.tickets.filter((x: any) => x.voided) : r.tickets;
  return (
    <>
      <Facts
        items={[
          {
            label: 'Gasto neto',
            value: money(t.net_cents),
            foot: BigInt(t.corrected_cents)
              ? `Compras ${money(t.gross_cents)} − correcciones ${money(t.corrected_cents)}`
              : undefined,
          },
          {
            label: 'Tickets',
            value: String(t.tickets),
            foot: t.voided ? `${plural(t.voided, 'anulado', 'anulados')} aparte` : undefined,
            warn: !!t.voided,
          },
          { label: 'Proveedores', value: String(r.by_supplier.length) },
        ]}
      />
      <Choice
        label="Vista"
        value={view}
        onChange={setView}
        options={[
          ['suppliers', 'Por proveedor', r.by_supplier.length],
          ['days', 'Por día'],
          ['tickets', 'Tickets', r.tickets.length],
          ['corrections', 'Correcciones', r.corrections.length],
        ]}
      />
      {view === 'suppliers' && (
        <Ranking
          empty="Sin compras en este periodo."
          items={r.by_supplier.map((s: any) => ({
            key: s.company,
            label: s.company,
            sub:
              plural(s.tickets, 'ticket', 'tickets') +
              (BigInt(s.corrected_cents) ? ` · corregido −${money(s.corrected_cents)}` : ''),
            value: BigInt(s.net_cents),
          }))}
        />
      )}
      {view === 'days' && (
        <Ranking
          empty="Sin compras en este periodo."
          items={r.by_day.map((d: any) => ({
            key: d.date,
            label: shortDate(d.date),
            sub: plural(d.tickets, 'ticket', 'tickets'),
            value: BigInt(d.gross_cents),
          }))}
        />
      )}
      {view === 'tickets' && (
        <Grid
          empty={voided ? 'Sin tickets anulados.' : 'Sin tickets en este periodo.'}
          tools={
            <label className="rp-check">
              <input
                type="checkbox"
                checked={voided}
                onChange={(e) => setVoided(e.target.checked)}
              />
              Solo anulados
            </label>
          }
          headers={['Fecha', 'Proveedor', 'Importe', 'Registró', 'Estado']}
          rows={tickets.map((x: any) => ({
            key: x.id,
            text: `${x.company} ${x.employee} ${x.note} ${x.void_reason || ''}`,
            cells: [
              when(x.occurred_at, zone),
              <>
                <strong>{x.company}</strong>
                {x.note && <small className="rp-sub">{x.note}</small>}
              </>,
              <>
                {money(x.amount_cents)}
                {BigInt(x.corrected_cents) !== 0n && (
                  <small className="rp-sub">corregido −{money(x.corrected_cents)}</small>
                )}
              </>,
              x.employee,
              x.voided ? (
                <Pill tone="warn">Anulado{x.void_reason ? `: ${x.void_reason}` : ''}</Pill>
              ) : (
                <Pill>Registrado</Pill>
              ),
            ],
          }))}
        />
      )}
      {view === 'corrections' && (
        <Grid
          empty="Sin correcciones en este periodo."
          headers={['Fecha', 'Proveedor', 'Tipo', 'Importe', 'Motivo', 'Registró']}
          rows={r.corrections.map((c: any) => ({
            key: c.id,
            text: `${c.company} ${c.reason} ${c.employee}`,
            cells: [
              when(c.occurred_at, zone),
              <strong>{c.company}</strong>,
              c.type === 'refund' ? 'Reembolso' : 'Documental',
              money(c.amount_cents),
              c.reason,
              c.employee,
            ],
          }))}
        />
      )}
    </>
  );
}

function SupplierCash({ r }: { r: any }) {
  const shifts: any[] = r.shifts;
  const open = shifts.filter((s) => s.counted_cents == null).length;
  const uneven = shifts.filter((s) => s.difference_cents != null && BigInt(s.difference_cents));
  return (
    <>
      <Facts
        items={[
          {
            label: 'Turnos',
            value: String(shifts.length),
            foot: open ? `${plural(open, 'abierto', 'abiertos')} ahora` : undefined,
          },
          {
            label: 'Diferencia acumulada',
            value: gap(r.totals.shift_difference_cents),
            foot: uneven.length
              ? plural(uneven.length, 'turno no cuadró', 'turnos no cuadraron')
              : undefined,
            warn: !!uneven.length,
          },
        ]}
      />
      <Grid
        empty="Sin turnos de caja en este periodo."
        headers={['Fecha', 'Responsable', 'Apertura', 'Esperado', 'Contado', 'Diferencia']}
        rows={shifts.map((s) => ({
          key: s.id,
          text: s.employee,
          cells: [
            shortDate(s.date),
            <strong>{s.employee}</strong>,
            money(s.opening_cents),
            s.expected_cents == null ? '—' : money(s.expected_cents),
            s.counted_cents == null ? <Pill tone="muted">Abierto</Pill> : money(s.counted_cents),
            <Difference cents={s.difference_cents} />,
          ],
        }))}
      />
    </>
  );
}

function Treasury({ r, zone }: { r: any; zone: string }) {
  const amount = (cents: string) =>
    BigInt(cents) === 0n ? (
      '—'
    ) : (
      <span className={BigInt(cents) < 0n ? 'negative-amount' : ''}>{signed(cents)}</span>
    );
  return (
    <>
      <Facts
        items={[
          { label: 'Movimientos', value: String(r.totals.entries) },
          {
            label: 'Efectivo',
            value: signed(r.totals.cash_cents),
            foot: 'Cambio en el periodo',
          },
          { label: 'Banco', value: signed(r.totals.bank_cents), foot: 'Cambio en el periodo' },
        ]}
      />
      <Grid
        empty="Sin movimientos de caja general en este periodo."
        headers={['Fecha', 'Concepto', 'Registró', 'Efectivo', 'Banco']}
        rows={r.entries.map((e: any) => ({
          key: e.id,
          text: `${e.note} ${treasuryKinds[e.kind] || ''} ${e.employee}`,
          cells: [
            when(e.occurred_at, zone),
            <>
              <strong>{treasuryKinds[e.kind] || e.note || e.kind}</strong>
              {e.note && e.note !== treasuryKinds[e.kind] && (
                <small className="rp-sub">{e.note}</small>
              )}
            </>,
            e.employee,
            amount(e.cash_cents),
            amount(e.bank_cents),
          ],
        }))}
      />
    </>
  );
}

function Staff({ r, zone, target }: { r: any; zone: string; target: Target }) {
  const t = r.totals;
  const [view, setView] = useState(target.view || 'people'),
    [person, setPerson] = useState('');
  const incidents: any[] = [
    ...r.absences.map((a: any) => ({
      key: `a-${a.id}`,
      user_id: a.user_id,
      date: a.date,
      kind: 'Falta',
      detail: `${a.employee} · horario ${a.start_time}–${a.end_time} sin entrada`,
    })),
    ...r.incidents.map((i: any) => ({
      key: i.id,
      user_id: i.user_id,
      date: i.date,
      kind: incidentNames[i.kind] || i.kind,
      detail: i.message,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const mine = (list: any[]) => (person ? list.filter((x) => x.user_id === person) : list);
  const who = (
    <select
      className="rp-select"
      aria-label="Persona"
      value={person}
      onChange={(e) => setPerson(e.target.value)}
    >
      <option value="">Todo el personal</option>
      {r.people.map((p: any) => (
        <option key={p.user_id} value={p.user_id}>
          {p.employee}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <Facts
        items={[
          { label: 'Horas trabajadas', value: hours(t.hours), foot: 'Entradas con salida' },
          { label: 'Faltas', value: String(t.absences), warn: !!t.absences },
          { label: 'Retardos', value: String(t.late), warn: !!t.late },
          { label: 'Salidas anticipadas', value: String(t.early_exit), warn: !!t.early_exit },
        ]}
      />
      <Choice
        label="Vista"
        value={view}
        onChange={setView}
        options={[
          ['people', 'Por persona', r.people.length],
          ['attendance', 'Asistencia', r.attendance.length],
          ['incidents', 'Faltas e incidencias', incidents.length],
        ]}
      />
      {view === 'people' && (
        <Grid
          empty="Sin actividad del personal en este periodo."
          headers={['Persona', 'Horas', 'Días', 'Faltas', 'Retardos', 'Salidas antes', 'Tareas']}
          rows={r.people.map((p: any) => ({
            key: p.user_id,
            text: p.employee,
            cells: [
              <button
                className="text-button rp-link"
                title="Ver su asistencia"
                onClick={() => {
                  setPerson(p.user_id);
                  setView('attendance');
                }}
              >
                {p.employee}
              </button>,
              <>
                {hours(p.hours)}
                <small className="rp-sub">
                  de {hours(p.scheduled_hours)} programadas
                  {p.open > 0 ? ` · ${p.open} en curso` : ''}
                </small>
              </>,
              p.days,
              p.absences ? <Pill tone="danger">{p.absences}</Pill> : 0,
              p.late ? <Pill tone="warn">{p.late}</Pill> : 0,
              p.early_exit ? <Pill tone="warn">{p.early_exit}</Pill> : 0,
              p.tasks ? (
                <>
                  {p.tasks_done} de {p.tasks}
                  {p.tasks_missed > 0 && (
                    <small className="rp-sub">{p.tasks_missed} no realizadas</small>
                  )}
                </>
              ) : (
                '—'
              ),
            ],
          }))}
        />
      )}
      {view === 'attendance' && (
        <Grid
          key={person}
          tools={who}
          empty="Sin entradas registradas en este periodo."
          headers={['Fecha', 'Persona', 'Horario', 'Entrada', 'Salida', 'Horas']}
          rows={mine(r.attendance).map((a: any) => ({
            key: a.id,
            text: a.employee,
            cells: [
              shortDate(a.date),
              <strong>{a.employee}</strong>,
              a.schedule || <Pill tone="muted">Sin horario</Pill>,
              when(a.clock_in, zone, false),
              a.clock_out ? when(a.clock_out, zone, false) : <Pill>En curso</Pill>,
              a.clock_out
                ? hours((Date.parse(a.clock_out) - Date.parse(a.clock_in)) / 3_600_000)
                : '—',
            ],
          }))}
        />
      )}
      {view === 'incidents' && (
        <>
          <Grid
            key={person}
            tools={who}
            empty="Sin faltas ni incidencias en este periodo."
            headers={['Fecha', 'Tipo', 'Detalle']}
            rows={mine(incidents).map((i) => ({
              key: i.key,
              text: `${i.kind} ${i.detail}`,
              cells: [
                shortDate(i.date),
                <Pill tone={i.kind === 'Falta' ? 'danger' : 'warn'}>{i.kind}</Pill>,
                i.detail,
              ],
            }))}
          />
          {r.absences.length > 0 && (
            <p className="rp-note">
              Una falta puede ser un registro pendiente de sincronizar; confírmala antes de actuar.
            </p>
          )}
        </>
      )}
    </>
  );
}

function Tasks({
  r,
  zone,
  branchId,
  onError,
  target,
}: {
  r: any;
  zone: string;
  branchId: string;
  onError: (e: unknown) => void;
  target: Target;
}) {
  const t = r.totals;
  const [status, setStatus] = useState(target.filter || 'all');
  const tasks = r.tasks.filter((x: any) =>
    status === 'all'
      ? true
      : status === 'done'
        ? x.completed_at
        : status === 'missed'
          ? x.missed
          : !x.completed_at && !x.missed,
  );
  async function photo(id: string) {
    try {
      const url = await imageUrl(id, branchId);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      onError(e);
    }
  }
  return (
    <>
      <Choice
        label="Estado"
        value={status}
        onChange={setStatus}
        options={[
          ['all', 'Todas', t.tasks],
          ['done', 'Cumplidas', t.tasks_done],
          ['pending', 'Pendientes', t.tasks - t.tasks_done - t.tasks_missed],
          ['missed', 'No realizadas', t.tasks_missed],
        ]}
      />
      <Grid
        key={status}
        empty="Sin tareas con este filtro."
        headers={['Fecha', 'Tarea', 'Persona', 'Estado', 'Evidencia']}
        rows={tasks.map((x: any) => ({
          key: x.id,
          text: `${x.title} ${x.employee} ${x.note}`,
          cells: [
            shortDate(x.date),
            <>
              <strong>{x.title}</strong>
              {x.priority === 'alta' && <small className="rp-sub">Prioridad alta</small>}
              {x.note && <small className="rp-sub">«{x.note}»</small>}
            </>,
            x.employee,
            x.completed_at ? (
              <Pill>Cumplida {when(x.completed_at, zone, false)}</Pill>
            ) : x.missed ? (
              <Pill tone="danger">No realizada</Pill>
            ) : (
              <Pill tone="warn">Pendiente</Pill>
            ),
            x.media_id ? (
              <button className="text-button rp-link" onClick={() => photo(x.media_id)}>
                Ver foto
              </button>
            ) : (
              '—'
            ),
          ],
        }))}
      />
    </>
  );
}

function Shortages({ r, zone, target }: { r: any; zone: string; target: Target }) {
  const t = r.totals;
  const [status, setStatus] = useState(target.filter || 'all');
  const list = r.shortages.filter((s: any) =>
    status === 'all' ? true : status === 'open' ? !s.resolved : s.resolved,
  );
  return (
    <>
      <Choice
        label="Estado"
        value={status}
        onChange={setStatus}
        options={[
          ['all', 'Todos', t.shortages],
          ['open', 'Pendientes', t.shortages_open],
          ['resolved', 'Resueltos', t.shortages - t.shortages_open],
        ]}
      />
      <Grid
        key={status}
        empty="Sin faltantes con este filtro."
        headers={['Fecha', 'Producto', 'Reportó', 'Estado']}
        rows={list.map((s: any) => ({
          key: s.id,
          text: `${s.product} ${s.employee} ${s.note}`,
          cells: [
            when(s.occurred_at, zone),
            <>
              <strong>{s.product}</strong>
              {s.note && <small className="rp-sub">{s.note}</small>}
            </>,
            s.employee,
            s.resolved ? <Pill>Resuelto</Pill> : <Pill tone="warn">Pendiente</Pill>,
          ],
        }))}
      />
    </>
  );
}

type AuditPage = { events: any[]; total: number; actions: string[]; people: string[] };
// The log is paged by the server (filters included), so no period is ever cut short.
function Audit({
  branchId,
  from,
  to,
  zone,
}: {
  branchId: string;
  from: string;
  to: string;
  zone: string;
}) {
  const [action, setAction] = useState(''),
    [person, setPerson] = useState(''),
    [page, setPage] = useState<AuditPage | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const query = (offset: number) =>
    `/reports/audit?branch_id=${branchId}&from=${from}&to=${to}&offset=${offset}` +
    `&action=${encodeURIComponent(action)}&person=${encodeURIComponent(person)}`;
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    request(query(0))
      .then((r) => current && setPage(r))
      .catch((e) => current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [branchId, from, to, action, person]);
  const more = () => {
    if (!page) return;
    setLoading(true);
    request(query(page.events.length))
      .then((r) => setPage({ ...r, events: [...page.events, ...r.events] }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  const events = page?.events ?? [];
  return (
    <>
      <div className="rp-tools">
        <select
          className="rp-select"
          aria-label="Acción"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">Todas las acciones</option>
          {(page?.actions ?? []).map((k) => (
            <option key={k} value={k}>
              {actions[k] || k}
            </option>
          ))}
        </select>
        <select
          className="rp-select"
          aria-label="Usuario"
          value={person}
          onChange={(e) => setPerson(e.target.value)}
        >
          <option value="">Todos los usuarios</option>
          {(page?.people ?? []).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="rp-count">
          {page ? `${events.length} de ${page.total} operaciones` : loading ? 'Cargando…' : ''}
        </span>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {page && !events.length && (
        <div className="empty">
          <ClipboardCheck size={30} />
          <p>Sin operaciones con este filtro.</p>
        </div>
      )}
      <ul className="rp-log">
        {events.map((e: any) => (
          <li key={e.id}>
            <details>
              <summary>
                <time>{when(e.received_at, zone)}</time>
                <strong>{actions[e.action] || e.action}</strong>
                <span>{e.employee}</span>
                <ChevronRight size={15} />
              </summary>
              {e.detail.length ? (
                <dl className="audit-detail">
                  {e.detail.map((d: any) => (
                    <Fragment key={d.label}>
                      <dt>{d.label}</dt>
                      <dd>{d.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              ) : (
                <p className="rp-note">Sin más detalle.</p>
              )}
            </details>
          </li>
        ))}
      </ul>
      {page && events.length < page.total && (
        <button className="secondary rp-more" disabled={loading} onClick={more}>
          {loading ? 'Cargando…' : `Ver más (${page.total - events.length} restantes)`}
        </button>
      )}
    </>
  );
}
