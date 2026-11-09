import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Check, Plus } from 'lucide-react';
import { money } from '../../../packages/domain/index.js';

// Pantalla de Usuarios: una ficha por persona, ordenadas por quién trabajó más recientemente, y al
// abrir una ficha la actividad de su sesión más reciente con flechas para recorrer las anteriores.
// Todo sale del snapshot que ya vive en el equipo (últimos 15 días), por lo que funciona offline.

export type BoardUser = {
  id: string;
  name: string;
  username: string;
  role: string;
  active: boolean;
  deleted_at?: string | null;
};

type Clock = {
  id: string;
  user_id: string;
  business_date: string;
  clock_in: string;
  clock_out: string | null;
};

export type Activity = { at: string; text: string; detail?: string; kind: string };

const ms = (v: string) => Date.parse(v);

// Sesiones de un usuario, de la más antigua a la más reciente.
export function sessionsOf(clock: Clock[], userId: string) {
  return clock.filter((c) => c.user_id === userId).sort((x, y) => ms(x.clock_in) - ms(y.clock_in));
}

// Primero quienes están activos ahora (el que entró antes, primero); después quienes trabajaron
// su sesión más reciente (la más reciente arriba); al final quienes no tienen sesiones.
export function orderUsers<T extends BoardUser>(users: T[], clock: Clock[]): T[] {
  const rank = (u: T) => {
    const sessions = sessionsOf(clock, u.id);
    const open = sessions.find((s) => !s.clock_out);
    const last = sessions.at(-1);
    return { open: open ? ms(open.clock_in) : null, last: last ? ms(last.clock_in) : null };
  };
  const ranked = users.filter((u) => !u.deleted_at).map((u) => ({ u, r: rank(u) }));
  const group = (x: (typeof ranked)[number]) => (x.r.open != null ? 0 : x.r.last != null ? 1 : 2);
  return ranked
    .sort(
      (a, b) =>
        group(a) - group(b) ||
        (group(a) === 0 ? a.r.open! - b.r.open! : 0) ||
        (group(a) === 1 ? b.r.last! - a.r.last! : 0) ||
        a.u.name.localeCompare(b.u.name, 'es'),
    )
    .map((x) => x.u);
}

// Todo lo que el usuario hizo dentro de una sesión, en orden cronológico.
export function activityOf(data: any, userId: string, session: Clock, nowMs: number): Activity[] {
  const from = ms(session.clock_in),
    to = session.clock_out ? ms(session.clock_out) : nowMs;
  const inside = (v?: string | null) => !!v && ms(v) >= from && ms(v) <= to;
  const out: Activity[] = [];
  const supplier = (id: string) =>
    (data.suppliers || []).find((s: any) => s.id === id)?.company || 'Proveedor';
  out.push({ at: session.clock_in, kind: 'clock', text: 'Registró su entrada' });
  for (const t of data.tasks || [])
    if (t.user_id === userId && inside(t.completed_at))
      out.push({
        at: t.completed_at,
        kind: 'task',
        text: `Tarea realizada: ${t.title}`,
        detail: t.note || undefined,
      });
  for (const s of data.shifts || []) {
    if (s.actor_user_id !== userId) continue;
    if (inside(s.opened_at))
      out.push({
        at: s.opened_at,
        kind: 'shift',
        text: 'Abrió el turno de caja de proveedores',
        detail: `Saldo inicial ${money(s.opening_cents)}`,
      });
    if (inside(s.closed_at))
      out.push({
        at: s.closed_at,
        kind: 'shift',
        text: 'Cerró el turno de caja de proveedores',
        detail:
          s.counted_cents != null
            ? `Contó ${money(s.counted_cents)} · diferencia ${money(s.difference_cents ?? 0)}`
            : undefined,
      });
  }
  for (const t of data.tickets || [])
    if (t.actor_user_id === userId && inside(t.occurred_at))
      out.push({
        at: t.occurred_at,
        kind: 'ticket',
        text: `Pago a ${supplier(t.supplier_id)}: ${money(t.amount_cents)}${t.voided ? ' (anulado)' : ''}`,
        detail: t.note || undefined,
      });
  for (const c of data.corrections || [])
    if (c.actor_user_id === userId && inside(c.occurred_at))
      out.push({
        at: c.occurred_at,
        kind: 'ticket',
        text: `Corrección de ticket: ${money(c.amount_cents)}`,
        detail: c.reason,
      });
  for (const e of data.supplier_events || [])
    if (e.actor_user_id === userId && inside(e.occurred_at) && e.amount_cents != null)
      out.push({
        at: e.occurred_at,
        kind: 'ticket',
        text: `Agregó efectivo a la caja de proveedores: ${money(e.amount_cents)}`,
      });
  for (const c of data.cuts || [])
    if (c.user_id === userId && inside(c.occurred_at))
      out.push({
        at: c.occurred_at,
        kind: 'cut',
        text: `Corte ${c.label.toLowerCase()} · caja ${c.register_number}`,
        detail: `Ventas ${money(c.sales_cents)} · declarado ${money(c.declared_cents)} · diferencia ${money(c.difference_cents)}`,
      });
  for (const s of data.shortages || [])
    if (s.actor_user_id === userId && inside(s.occurred_at))
      out.push({
        at: s.occurred_at,
        kind: 'shortage',
        text: `Reportó faltante: ${s.product}`,
        detail: s.note || undefined,
      });
  for (const a of data.audit || []) {
    if (a.actor_user_id !== userId || !inside(a.received_at)) continue;
    if (a.action === 'register.select')
      out.push({
        at: a.received_at,
        kind: 'register',
        text: `Entró a la caja ${a.payload?.register_number}`,
      });
    if (a.action === 'register.leave')
      out.push({
        at: a.received_at,
        kind: 'register',
        text: `Salió de la caja ${a.payload?.register_number}`,
      });
  }
  if (session.clock_out)
    out.push({ at: session.clock_out, kind: 'clock', text: 'Registró su salida' });
  return out.sort((x, y) => ms(x.at) - ms(y.at));
}

function hour(value: string, zone: string) {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
function dayName(date: string, long = false) {
  const text = new Intl.DateTimeFormat('es-MX', {
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function duration(from: string, to: number) {
  const minutes = Math.max(0, Math.round((to - ms(from)) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export default function UserBoard({
  data,
  now,
  roleLabels,
  currentUserId,
  canManage,
  onCreate,
  onDeactivate,
  onDelete,
  actionsHidden,
}: {
  data: any;
  now: number;
  roleLabels: Record<string, string>;
  currentUserId: string;
  canManage: (u: BoardUser) => boolean;
  onCreate: () => void;
  onDeactivate: (u: BoardUser) => void;
  onDelete: (u: BoardUser) => void;
  actionsHidden?: boolean;
}) {
  const zone: string = data.branch.timezone;
  const [selected, setSelected] = useState<string | null>(null);
  // null = la sesión más reciente; si llega una nueva, el usuario sigue viendo la más reciente.
  const [offset, setOffset] = useState(0);
  const users = orderUsers<BoardUser>(data.users || [], data.clock || []);
  const user = users.find((u) => u.id === selected);

  if (user) {
    const sessions = sessionsOf(data.clock || [], user.id);
    const index = Math.min(Math.max(sessions.length - 1 - offset, 0), sessions.length - 1);
    const session = sessions[index];
    const live = session && !session.clock_out;
    const feed = session ? activityOf(data, user.id, session, now) : [];
    const tasks = session
      ? (data.tasks || []).filter(
          (t: any) =>
            t.user_id === user.id && t.due_date.slice(0, 10) === session.business_date.slice(0, 10),
        )
      : [];
    const planned = session
      ? (data.schedules || []).filter(
          (s: any) =>
            s.user_id === user.id &&
            s.business_date.slice(0, 10) === session.business_date.slice(0, 10),
        )
      : [];
    const lease = (data.occupied_registers || []).find((r: any) => r.user_id === user.id);
    return (
      <section className="user-detail">
        <button
          className="text-button"
          onClick={() => {
            setSelected(null);
            setOffset(0);
          }}
        >
          ← Volver a usuarios
        </button>
        <div className="card user-detail-head">
          <span className="user-avatar large" aria-hidden="true">
            {initials(user.name)}
          </span>
          <div>
            <h2>{user.name}</h2>
            <p className="muted">
              {user.username} · {roleLabels[user.role]} · {user.active ? 'Activo' : 'Inactivo'}
            </p>
          </div>
        </div>
        {session ? (
          <div className="card">
            <div className="session-nav" role="group" aria-label="Sesiones del usuario">
              <button
                className="icon-button"
                aria-label="Sesión anterior"
                disabled={index === 0}
                onClick={() => setOffset(offset + 1)}
              >
                <ChevronLeft />
              </button>
              <div className="session-title">
                <strong>{dayName(session.business_date, true)}</strong>
                <small>
                  Sesión {index + 1} de {sessions.length}
                  {index === sessions.length - 1 ? ' · la más reciente' : ''}
                </small>
              </div>
              <button
                className="icon-button"
                aria-label="Sesión siguiente"
                disabled={index === sessions.length - 1}
                onClick={() => setOffset(Math.max(offset - 1, 0))}
              >
                <ChevronRight />
              </button>
            </div>
            <dl className="session-facts">
              <div>
                <dt>Estado</dt>
                <dd>
                  {live ? (
                    <span className="badge">
                      <span className="live-dot" aria-hidden="true" /> En turno
                    </span>
                  ) : (
                    'Turno terminado'
                  )}
                </dd>
              </div>
              <div>
                <dt>Entrada</dt>
                <dd>{hour(session.clock_in, zone)}</dd>
              </div>
              <div>
                <dt>Salida</dt>
                <dd>{session.clock_out ? hour(session.clock_out, zone) : 'En curso'}</dd>
              </div>
              <div>
                <dt>Duración</dt>
                <dd>
                  {duration(session.clock_in, session.clock_out ? ms(session.clock_out) : now)}
                </dd>
              </div>
              {live && (
                <div>
                  <dt>Caja</dt>
                  <dd>{lease ? `Caja ${lease.register_number}` : 'Sin caja'}</dd>
                </div>
              )}
              {planned.length > 0 && (
                <div>
                  <dt>Horario</dt>
                  <dd>
                    {planned
                      .map((s: any) => `${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}`)
                      .join(', ')}
                  </dd>
                </div>
              )}
            </dl>
            <h3 className="section-label">
              Tareas del día{' '}
              {tasks.length > 0 &&
                `· ${tasks.filter((t: any) => t.completed_at).length}/${tasks.length}`}
            </h3>
            {tasks.length ? (
              <ul className="session-tasks">
                {tasks.map((t: any) => (
                  <li key={t.id}>
                    <span>{t.title}</span>
                    {t.completed_at ? (
                      <span className="badge">
                        <Check size={14} />
                        Realizada · {hour(t.completed_at, zone)}
                      </span>
                    ) : (
                      <span className="badge amber-badge">Pendiente</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No tenía tareas asignadas ese día.</p>
            )}
            <h3 className="section-label">Actividad de la sesión</h3>
            <ol className="activity">
              {feed.map((a, i) => (
                <li key={`${a.at}-${i}`} className={`activity-${a.kind}`}>
                  <time>{hour(a.at, zone)}</time>
                  <div>
                    <span>{a.text}</span>
                    {a.detail && <small>{a.detail}</small>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="card">
            <p className="muted">
              Este usuario no tiene sesiones en los últimos 15 días. Lo anterior está en Reportes ›
              Auditoría.
            </p>
          </div>
        )}
        {!actionsHidden && user.id !== currentUserId && canManage(user) && (
          <div className="card user-actions">
            {user.active && (
              <button className="danger-link" onClick={() => onDeactivate(user)}>
                Desactivar
              </button>
            )}
            <button className="danger-link" onClick={() => onDelete(user)}>
              Eliminar {roleLabels[user.role].toLowerCase()}
            </button>
          </div>
        )}
      </section>
    );
  }

  const cardFor = (u: BoardUser): ReactNode => {
    const sessions = sessionsOf(data.clock || [], u.id);
    const open = sessions.find((s) => !s.clock_out);
    const last = sessions.at(-1);
    return (
      <button
        key={u.id}
        type="button"
        className={`user-card${open ? ' working' : ''}${u.active ? '' : ' inactive'}`}
        onClick={() => {
          setSelected(u.id);
          setOffset(0);
        }}
      >
        <span className="user-avatar" aria-hidden="true">
          {initials(u.name)}
        </span>
        <strong>{u.name}</strong>
        <small>
          {u.username} · {roleLabels[u.role]}
        </small>
        <span className="user-status">
          {open ? (
            <>
              <span className="live-dot" aria-hidden="true" /> Activo desde las{' '}
              {hour(open.clock_in, zone)}
            </>
          ) : last ? (
            `${dayName(last.business_date)} · ${hour(last.clock_in, zone)}${last.clock_out ? `–${hour(last.clock_out, zone)}` : ''}`
          ) : (
            'Sin sesiones recientes'
          )}
          {!u.active && ' · Inactivo'}
        </span>
      </button>
    );
  };

  return (
    <>
      <div className="user-toolbar">
        <p className="muted">
          {users.length} {users.length === 1 ? 'persona' : 'personas'} · primero quienes están en
          turno
        </p>
        <button
          className="add-button"
          aria-label="Nuevo usuario"
          title="Nuevo usuario"
          onClick={onCreate}
        >
          <Plus size={22} />
        </button>
      </div>
      <div className="user-grid">{users.map(cardFor)}</div>
    </>
  );
}
