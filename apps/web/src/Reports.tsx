import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ClipboardCheck,
  Clock3,
  Download,
  PackageX,
  Receipt,
  ShieldCheck,
  ShoppingBag,
  Timer,
  Users,
} from 'lucide-react';
import { money, auditActions as actions } from '../../../packages/domain/index.js';
import { request, download, imageUrl } from './api';
import { addDays } from './ScheduleBoard';

// Reports always cover the branch picked at sign-in; only the period changes here.
const tabs = ['Gastos y proveedores', 'Personal', 'Operación', 'Auditoría'] as const;
type Tab = (typeof tabs)[number];
type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'last-month' | 'custom';
const presets: [Preset, string][] = [
  ['today', 'Hoy'],
  ['yesterday', 'Ayer'],
  ['week', 'Últimos 7 días'],
  ['month', 'Este mes'],
  ['last-month', 'Mes anterior'],
  ['custom', 'Personalizado'],
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
const priorities: Record<string, string> = { alta: 'Alta', normal: 'Normal' };

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

function Section({
  title,
  subtitle,
  children,
  aside,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-title report-card-title">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
function Tile({
  title,
  value,
  foot,
  icon,
  tone,
}: {
  title: string;
  value: string;
  foot?: string;
  icon: ReactNode;
  tone?: 'warn';
}) {
  return (
    <div className={`stat${tone === 'warn' ? ' stat-warn' : ''}`}>
      <div className="stat-top">
        <span>{title}</span>
        <i>{icon}</i>
      </div>
      <strong>{value}</strong>
      {foot && <p>{foot}</p>}
    </div>
  );
}
// A table with a text search over every cell and a footer row for totals.
function Grid({
  headers,
  rows,
  empty,
  footer,
  search = true,
}: {
  headers: string[];
  rows: { key: string; cells: ReactNode[]; text: string }[];
  empty: string;
  footer?: ReactNode[];
  search?: boolean;
}) {
  const [query, setQuery] = useState('');
  const shown = query
    ? rows.filter((r) => r.text.toLowerCase().includes(query.trim().toLowerCase()))
    : rows;
  if (!rows.length)
    return (
      <div className="empty">
        <ClipboardCheck size={30} />
        <p>{empty}</p>
      </div>
    );
  return (
    <>
      {search && rows.length > 8 && (
        <input
          className="report-search"
          type="search"
          placeholder="Buscar…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="table-wrap">
        <table>
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
                  <td key={i}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && (
            <tfoot>
              <tr>
                {footer.map((c, i) => (
                  <td key={i}>{c}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {query && !shown.length && <p className="report-note">Sin resultados para «{query}».</p>}
    </>
  );
}
// Horizontal bars: enough to compare suppliers or days without a chart library.
function Bars({ items }: { items: { label: string; value: bigint; foot: string }[] }) {
  const max = items.reduce((m, i) => (i.value > m ? i.value : m), 0n);
  if (!items.length || max === 0n) return null;
  return (
    <div className="report-bars">
      {items.map((i) => (
        <div className="report-bar" key={i.label}>
          <span>{i.label}</span>
          <div>
            <i style={{ width: `${Math.max(2, Number((i.value * 1000n) / max) / 10)}%` }} />
          </div>
          <strong>{i.foot}</strong>
        </div>
      ))}
    </div>
  );
}
const tones = { warn: ' amber-badge', muted: ' muted-badge', danger: ' danger-badge' };
const Pill = ({ children, tone }: { children: ReactNode; tone?: 'warn' | 'muted' | 'danger' }) => (
  <span className={`badge${tone ? tones[tone] : ''}`}>{children}</span>
);

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
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem('reports.tab') as Tab;
      return tabs.includes(saved) ? saved : tabs[0];
    } catch {
      return tabs[0];
    }
  });
  const [preset, setPreset] = useState<Preset>('today'),
    [custom, setCustom] = useState<[string, string]>([today, today]),
    [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [exporting, setExporting] = useState(false);
  const [from, to] = preset === 'custom' ? custom : period(preset, today);
  useEffect(() => {
    try {
      localStorage.setItem('reports.tab', tab);
    } catch {
      /* Solo recuerda la pestaña; sin almacenamiento se abre la primera. */
    }
  }, [tab]);
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
  const label = from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  return (
    <div className="reports">
      <div className="report-toolbar card">
        <div className="report-periods" role="group" aria-label="Periodo">
          {presets.map(([key, text]) => (
            <button
              key={key}
              className={`report-chip${preset === key ? ' selected' : ''}`}
              onClick={() => {
                if (key === 'custom') setCustom([from, to]);
                setPreset(key);
              }}
            >
              {text}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="report-dates">
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
        <div className="report-toolbar-end">
          <span>
            {branchName} · {label}
          </span>
          <button
            className="primary"
            disabled={exporting || !data}
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
            <Download size={15} /> {exporting ? 'Generando…' : 'Exportar Excel'}
          </button>
        </div>
      </div>
      <div className="report-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'selected' : ''}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!data ? (
        <p className="report-note">{loading ? 'Cargando reportes…' : ''}</p>
      ) : (
        <div className={loading ? 'report-body is-loading' : 'report-body'}>
          {tab === 'Gastos y proveedores' && <Expenses r={data.expenses} zone={zone} />}
          {tab === 'Personal' && <Staff r={data.staff} zone={zone} />}
          {tab === 'Operación' && (
            <Operations r={data.operations} zone={zone} branchId={branchId} onError={onError} />
          )}
          {tab === 'Auditoría' && <Audit r={data.audit} zone={zone} />}
        </div>
      )}
    </div>
  );
}

function Expenses({ r, zone }: { r: any; zone: string }) {
  const t = r.totals;
  const difference = BigInt(t.shift_difference_cents);
  return (
    <>
      <div className="stats">
        <Tile
          title="Gasto neto"
          value={money(t.net_cents)}
          foot={`Compras ${money(t.gross_cents)} − correcciones ${money(t.corrected_cents)}`}
          icon={<ShoppingBag />}
        />
        <Tile
          title="Tickets"
          value={String(t.tickets)}
          foot={t.voided ? `${t.voided} anulados aparte` : 'Sin tickets anulados'}
          icon={<Receipt />}
        />
        <Tile
          title="Proveedores"
          value={String(r.by_supplier.length)}
          foot="Con compras en el periodo"
          icon={<Users />}
        />
        <Tile
          title="Diferencia caja proveedores"
          value={money(t.shift_difference_cents)}
          foot={`${r.shifts.length} turnos de caja`}
          icon={<AlertTriangle />}
          tone={difference !== 0n ? 'warn' : undefined}
        />
      </div>
      <div className="grid report-grid">
        <Section
          title="Gasto por proveedor"
          subtitle="Ordenado de mayor a menor; no incluye anulados."
        >
          <Bars
            items={r.by_supplier.slice(0, 8).map((s: any) => ({
              label: s.company,
              value: BigInt(s.net_cents),
              foot: money(s.net_cents),
            }))}
          />
          <Grid
            empty="Sin compras en este periodo."
            headers={['Proveedor', 'Tickets', 'Compras', 'Correcciones', 'Neto']}
            rows={r.by_supplier.map((s: any) => ({
              key: s.company,
              text: s.company,
              cells: [
                s.company,
                s.tickets,
                money(s.gross_cents),
                money(s.corrected_cents),
                <strong>{money(s.net_cents)}</strong>,
              ],
            }))}
            footer={[
              'Total',
              t.tickets,
              money(t.gross_cents),
              money(t.corrected_cents),
              <strong>{money(t.net_cents)}</strong>,
            ]}
          />
        </Section>
        <Section title="Gasto por día">
          <Bars
            items={r.by_day.map((d: any) => ({
              label: shortDate(d.date),
              value: BigInt(d.gross_cents),
              foot: money(d.gross_cents),
            }))}
          />
          {!r.by_day.length && <p className="report-note">Sin compras en este periodo.</p>}
        </Section>
      </div>
      <Section
        title="Tickets de compra y pago"
        subtitle={`${r.tickets.length} registros en el periodo`}
      >
        <Grid
          empty="Sin tickets en este periodo."
          headers={['Fecha', 'Proveedor', 'Importe', 'Registró', 'Estado', 'Nota']}
          rows={r.tickets.map((x: any) => ({
            key: x.id,
            text: `${x.company} ${x.employee} ${x.note} ${x.void_reason || ''}`,
            cells: [
              when(x.occurred_at, zone),
              x.company,
              BigInt(x.corrected_cents) ? (
                <>
                  {money(x.amount_cents)}
                  <small className="report-sub">corregido −{money(x.corrected_cents)}</small>
                </>
              ) : (
                money(x.amount_cents)
              ),
              x.employee,
              x.voided ? (
                <Pill tone="warn">Anulado{x.void_reason ? `: ${x.void_reason}` : ''}</Pill>
              ) : (
                <Pill>Registrado</Pill>
              ),
              x.note || '—',
            ],
          }))}
        />
      </Section>
      <div className="grid report-grid">
        <Section
          title="Turnos de caja proveedores"
          subtitle="Apertura, lo que el sistema esperaba y lo que se contó al cerrar."
        >
          <Grid
            empty="Sin turnos de caja en este periodo."
            headers={['Fecha', 'Responsable', 'Apertura', 'Esperado', 'Contado', 'Diferencia']}
            rows={r.shifts.map((s: any) => ({
              key: s.id,
              text: s.employee,
              cells: [
                shortDate(s.date),
                s.employee,
                money(s.opening_cents),
                s.expected_cents == null ? '—' : money(s.expected_cents),
                s.counted_cents == null ? (
                  <Pill tone="muted">Abierto</Pill>
                ) : (
                  money(s.counted_cents)
                ),
                s.difference_cents == null ? (
                  '—'
                ) : BigInt(s.difference_cents) !== 0n ? (
                  <Pill tone="warn">{money(s.difference_cents)}</Pill>
                ) : (
                  money(s.difference_cents)
                ),
              ],
            }))}
          />
        </Section>
        <Section title="Correcciones a tickets">
          <Grid
            empty="Sin correcciones en este periodo."
            headers={['Fecha', 'Proveedor', 'Tipo', 'Importe', 'Motivo']}
            rows={r.corrections.map((c: any) => ({
              key: c.id,
              text: `${c.company} ${c.reason} ${c.employee}`,
              cells: [
                when(c.occurred_at, zone),
                c.company,
                c.type === 'refund' ? 'Reembolso' : 'Documental',
                money(c.amount_cents),
                c.reason,
              ],
            }))}
          />
        </Section>
      </div>
    </>
  );
}

function Staff({ r, zone }: { r: any; zone: string }) {
  const t = r.totals;
  const incidents = [
    ...r.absences.map((a: any) => ({
      key: `a-${a.id}`,
      date: a.date,
      kind: 'Falta',
      employee: a.employee,
      detail: `Horario ${a.start_time}–${a.end_time} sin entrada`,
    })),
    ...r.incidents.map((i: any) => ({
      key: i.id,
      date: i.date,
      kind: incidentNames[i.kind] || i.kind,
      employee: '',
      detail: i.message,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <div className="stats">
        <Tile
          title="Horas trabajadas"
          value={hours(t.hours)}
          icon={<Timer />}
          foot="Entradas cerradas"
        />
        <Tile
          title="Faltas"
          value={String(t.absences)}
          foot="Horarios sin entrada registrada"
          icon={<AlertTriangle />}
          tone={t.absences ? 'warn' : undefined}
        />
        <Tile
          title="Retardos y salidas"
          value={`${t.late} · ${t.early_exit}`}
          foot="Retardos · salidas anticipadas"
          icon={<Clock3 />}
          tone={t.late || t.early_exit ? 'warn' : undefined}
        />
        <Tile
          title="Tareas cumplidas"
          value={t.tasks ? `${Math.round((t.tasks_done / t.tasks) * 100)}%` : '—'}
          foot={`${t.tasks_done} de ${t.tasks} · ${t.tasks_missed} no realizadas`}
          icon={<ClipboardCheck />}
          tone={t.tasks_missed ? 'warn' : undefined}
        />
      </div>
      <Section
        title="Resumen por empleado"
        subtitle="Programado contra lo que realmente se registró."
      >
        <Grid
          empty="Sin actividad del personal en este periodo."
          headers={[
            'Empleado',
            'Turnos',
            'Horas programadas',
            'Días trabajados',
            'Horas trabajadas',
            'Faltas',
            'Retardos',
            'Salidas antes',
            'Tareas',
          ]}
          rows={r.people.map((p: any) => ({
            key: p.user_id,
            text: p.employee,
            cells: [
              <strong>{p.employee}</strong>,
              p.scheduled,
              hours(p.scheduled_hours),
              p.days,
              <>
                {hours(p.hours)}
                {p.open > 0 && <small className="report-sub">{p.open} en curso</small>}
              </>,
              p.absences ? <Pill tone="warn">{p.absences}</Pill> : 0,
              p.late ? <Pill tone="warn">{p.late}</Pill> : 0,
              p.early_exit ? <Pill tone="warn">{p.early_exit}</Pill> : 0,
              p.tasks ? (
                <>
                  {p.tasks_done}/{p.tasks}
                  {p.tasks_missed > 0 && (
                    <small className="report-sub">{p.tasks_missed} no realizadas</small>
                  )}
                </>
              ) : (
                '—'
              ),
            ],
          }))}
        />
      </Section>
      <Section
        title="Faltas e incidencias"
        subtitle="Una falta puede ser un registro pendiente de sincronizar; confírmala antes de actuar."
      >
        <Grid
          empty="Sin faltas ni incidencias en este periodo."
          headers={['Fecha', 'Tipo', 'Detalle']}
          rows={incidents.map((i) => ({
            key: i.key,
            text: `${i.kind} ${i.employee} ${i.detail}`,
            cells: [
              shortDate(i.date),
              <Pill tone="warn">{i.kind}</Pill>,
              i.employee ? `${i.employee} · ${i.detail}` : i.detail,
            ],
          }))}
        />
      </Section>
      <Section title="Asistencia registrada">
        <Grid
          empty="Sin entradas registradas en este periodo."
          headers={['Empleado', 'Fecha', 'Horario', 'Entrada', 'Salida', 'Horas']}
          rows={r.attendance.map((a: any) => ({
            key: a.id,
            text: a.employee,
            cells: [
              a.employee,
              shortDate(a.date),
              a.schedule || <Pill tone="muted">Sin horario</Pill>,
              when(a.clock_in, zone, false),
              a.clock_out ? when(a.clock_out, zone, false) : <Pill>En curso</Pill>,
              a.clock_out
                ? hours((Date.parse(a.clock_out) - Date.parse(a.clock_in)) / 3_600_000)
                : '—',
            ],
          }))}
        />
      </Section>
    </>
  );
}

function Operations({
  r,
  zone,
  branchId,
  onError,
}: {
  r: any;
  zone: string;
  branchId: string;
  onError: (e: unknown) => void;
}) {
  const t = r.totals;
  const [status, setStatus] = useState<'all' | 'pending' | 'done' | 'missed'>('all');
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
      <div className="stats">
        <Tile
          title="Faltantes reportados"
          value={String(t.shortages)}
          foot={`${t.shortages_open} pendientes de resolver`}
          icon={<PackageX />}
          tone={t.shortages_open ? 'warn' : undefined}
        />
        <Tile
          title="Tareas del periodo"
          value={String(t.tasks)}
          foot={`${t.tasks_done} cumplidas · ${t.tasks_missed} no realizadas · ${t.tasks - t.tasks_done - t.tasks_missed} pendientes`}
          icon={<ClipboardCheck />}
          tone={t.tasks_missed ? 'warn' : undefined}
        />
      </div>
      <Section title="Faltantes de producto">
        <Grid
          empty="Sin faltantes reportados en este periodo."
          headers={['Fecha', 'Producto', 'Reportó', 'Nota', 'Estado']}
          rows={r.shortages.map((s: any) => ({
            key: s.id,
            text: `${s.product} ${s.employee} ${s.note}`,
            cells: [
              when(s.occurred_at, zone),
              <strong>{s.product}</strong>,
              s.employee,
              s.note || '—',
              s.resolved ? <Pill>Resuelto</Pill> : <Pill tone="warn">Pendiente</Pill>,
            ],
          }))}
        />
      </Section>
      <Section
        title="Tareas"
        aside={
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">Todas</option>
            <option value="pending">Pendientes</option>
            <option value="done">Cumplidas</option>
            <option value="missed">No realizadas</option>
          </select>
        }
      >
        <Grid
          empty="Sin tareas con este filtro."
          headers={['Fecha', 'Tarea', 'Empleado', 'Prioridad', 'Estado', 'Evidencia']}
          rows={tasks.map((x: any) => ({
            key: x.id,
            text: `${x.title} ${x.employee} ${x.note}`,
            cells: [
              shortDate(x.date),
              <>
                {x.title}
                {x.note && <small className="report-sub">{x.note}</small>}
              </>,
              x.employee,
              priorities[x.priority] || x.priority,
              x.completed_at ? (
                <Pill>Cumplida {when(x.completed_at, zone, false)}</Pill>
              ) : x.missed ? (
                <Pill tone="danger">No realizada</Pill>
              ) : (
                <Pill tone="warn">Pendiente</Pill>
              ),
              x.media_id ? (
                <button className="text-button" onClick={() => photo(x.media_id)}>
                  Ver foto
                </button>
              ) : (
                '—'
              ),
            ],
          }))}
        />
      </Section>
    </>
  );
}

function Audit({ r, zone }: { r: any; zone: string }) {
  const [action, setAction] = useState(''),
    [person, setPerson] = useState('');
  const names = useMemo(
    () => [...new Set<string>(r.events.map((e: any) => e.employee))].sort(),
    [r.events],
  );
  const kinds = useMemo(
    () => [...new Set<string>(r.events.map((e: any) => e.action))].sort(),
    [r.events],
  );
  const events = r.events.filter(
    (e: any) => (!action || e.action === action) && (!person || e.employee === person),
  );
  return (
    <Section
      title="Bitácora de operaciones"
      subtitle={
        r.truncated
          ? 'Se muestran las 2,000 operaciones más recientes; acorta el periodo para ver el resto.'
          : `${r.events.length} operaciones en el periodo`
      }
      aside={
        <div className="report-filters">
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Todas las acciones</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {actions[k] || k}
              </option>
            ))}
          </select>
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Todos los usuarios</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <Grid
        empty="Sin operaciones con este filtro."
        headers={['Fecha', 'Acción', 'Usuario', 'Detalle']}
        rows={events.map((e: any) => ({
          key: e.id,
          text: `${actions[e.action] || e.action} ${e.employee} ${e.detail.map((d: any) => `${d.label} ${d.value}`).join(' ')}`,
          cells: [
            when(e.received_at, zone),
            actions[e.action] || e.action,
            e.employee,
            <details className="report-detail">
              <summary>Ver</summary>
              <dl className="audit-detail">
                {e.detail.map((d: any) => (
                  <Fragment key={d.label}>
                    <dt>{d.label}</dt>
                    <dd>{d.value}</dd>
                  </Fragment>
                ))}
              </dl>
            </details>,
          ],
        }))}
      />
    </Section>
  );
}
