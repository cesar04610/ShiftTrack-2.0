import { useState, type FormEvent } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Moon,
  Pencil,
  Plus,
  RotateCcw,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { addDays } from './ScheduleBoard';

type Shift = 'morning' | 'afternoon';
type Config = { shift: Shift; half: boolean; register_number: number };
type Item = Config & { id: string; title: string; weekdays: number[] };
type Task = {
  id: string;
  user_id: string;
  title: string;
  due_date: string;
  completed_at?: string | null;
  note?: string;
  media_id?: string | null;
  setup_item_id?: string | null;
  shift?: Shift | null;
  half?: boolean | null;
  register_number?: number | null;
};
type Person = { id: string; name: string; active: boolean };

// The four lists every register has, in the order of the day.
export const shiftTypes: { shift: Shift; half: boolean; name: string; hours: string }[] = [
  { shift: 'morning', half: false, name: 'Turno mañana', hours: '07:30 – 15:00' },
  { shift: 'morning', half: true, name: 'Medio turno mañana', hours: '12:00 – 15:00' },
  { shift: 'afternoon', half: false, name: 'Turno tarde', hours: '15:00 – 21:30' },
  { shift: 'afternoon', half: true, name: 'Medio turno tarde', hours: '18:30 – 21:30' },
];
export function setupLabel(c: {
  shift?: Shift | null;
  half?: boolean | null;
  register_number?: number | null;
}) {
  const type = shiftTypes.find((t) => t.shift === c.shift && t.half === !!c.half);
  return `Caja ${c.register_number} · ${type?.name ?? 'Turno'}`;
}
// Monday first, as the week is read in the store; values follow JavaScript (0 is Sunday).
const days = [
  { value: 1, letter: 'L', name: 'Lun' },
  { value: 2, letter: 'M', name: 'Mar' },
  { value: 3, letter: 'X', name: 'Mié' },
  { value: 4, letter: 'J', name: 'Jue' },
  { value: 5, letter: 'V', name: 'Vie' },
  { value: 6, letter: 'S', name: 'Sáb' },
  { value: 0, letter: 'D', name: 'Dom' },
];
const daysLabel = (weekdays: number[]) =>
  weekdays.length >= 7
    ? 'Todos los días'
    : days
        .filter((d) => weekdays.includes(d.value))
        .map((d) => d.name)
        .join(', ');
const typeIndex = (c: Config) =>
  shiftTypes.findIndex((t) => t.shift === c.shift && t.half === c.half);
const same = (a: Config, b: Config) =>
  a.shift === b.shift && a.half === b.half && a.register_number === b.register_number;
function longDate(date: string) {
  const label = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export default function TaskBoard({
  items,
  tasks,
  users,
  registerCount,
  occupied,
  workDay,
  since,
  online,
  onSave,
  onPhoto,
}: {
  items: Item[];
  tasks: Task[];
  users: Person[];
  registerCount: number;
  // Who holds each register right now.
  occupied: { register_number: number; user_id: string }[];
  // Today's work day (05:00 to 05:00) in the branch.
  workDay: string;
  // First day the screen has tasks for; earlier ones are only in Reportes.
  since?: string;
  online: boolean;
  onSave: (path: string, values: Record<string, unknown>) => Promise<void>;
  onPhoto: (mediaId: string) => void;
}) {
  const [tab, setTab] = useState<'lists' | 'day'>('lists'),
    [register, setRegister] = useState(1),
    [day, setDay] = useState(workDay),
    [extra, setExtra] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const caja = Math.min(register, registerCount);
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? 'Persona eliminada';
  // Every change goes through here: one at a time, with its error shown on the page.
  async function save(path: string, values: Record<string, unknown>) {
    setError('');
    setBusy(true);
    try {
      await onSave(path, values);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || !online;
  const working = occupied.find((o) => o.register_number === caja);
  const dayTasks = tasks.filter((t) => t.due_date.slice(0, 10) === day);
  const people = [...new Set(dayTasks.map((t) => t.user_id))]
    .map((id) => ({ id, name: nameOf(id), list: dayTasks.filter((t) => t.user_id === id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const done = dayTasks.filter((t) => t.completed_at).length;

  return (
    <div className="task-board">
      <div className="task-toolbar">
        <div className="task-tabs" role="tablist" aria-label="Vista de tareas">
          <button
            role="tab"
            aria-selected={tab === 'lists'}
            className={tab === 'lists' ? 'active' : ''}
            onClick={() => setTab('lists')}
          >
            Tareas por caja y turno
          </button>
          <button
            role="tab"
            aria-selected={tab === 'day'}
            className={tab === 'day' ? 'active' : ''}
            onClick={() => setTab('day')}
          >
            Seguimiento
          </button>
        </div>
        <button className="primary task-extra-button" onClick={() => setExtra((v) => !v)}>
          <Plus size={16} />
          Tarea extra
        </button>
      </div>
      {!online && (
        <div className="notice">Sin conexión: puedes consultar, pero no guardar cambios.</div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {extra && (
        <ExtraForm
          users={users.filter((u) => u.active)}
          workDay={workDay}
          locked={locked}
          onCancel={() => setExtra(false)}
          onSubmit={async (values) => {
            if (!(await save('/tasks', values))) return false;
            setExtra(false);
            setDay(values.due_date);
            setTab('day');
            return true;
          }}
        />
      )}
      {tab === 'lists' && (
        <>
          <p className="task-hint">
            Escribe una sola vez las tareas de cada caja y turno. Quien trabaje ese turno en esa
            caja las recibe automáticamente al entrar, todas las semanas.
          </p>
          <div className="task-registers" role="group" aria-label="Caja">
            {Array.from({ length: registerCount }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                className={n === caja ? 'active' : ''}
                aria-pressed={n === caja}
                onClick={() => setRegister(n)}
              >
                Caja {n}
                <small>{items.filter((i) => i.register_number === n).length}</small>
              </button>
            ))}
            {working && <span className="task-working">Ahora: {nameOf(working.user_id)}</span>}
          </div>
          <div className="task-lists">
            {shiftTypes.map((type) => {
              const target = { shift: type.shift, half: type.half, register_number: caja };
              return (
                <SetupList
                  key={`${caja}-${type.shift}-${type.half}`}
                  type={type}
                  target={target}
                  list={items.filter((i) => same(i, target))}
                  all={items}
                  locked={locked}
                  save={save}
                />
              );
            })}
          </div>
        </>
      )}
      {tab === 'day' && (
        <>
          <div className="task-day-nav">
            <button
              className="icon-button"
              aria-label="Día anterior"
              disabled={!!since && day <= since}
              onClick={() => setDay(addDays(day, -1))}
            >
              <ChevronLeft size={18} />
            </button>
            <div>
              <strong>{day === workDay ? `Hoy · ${longDate(day)}` : longDate(day)}</strong>
              <small>
                {dayTasks.length
                  ? `${done} de ${dayTasks.length} tareas realizadas`
                  : 'Sin tareas este día'}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label="Día siguiente"
              onClick={() => setDay(addDays(day, 1))}
            >
              <ChevronRight size={18} />
            </button>
            {day !== workDay && (
              <button className="secondary" onClick={() => setDay(workDay)}>
                Hoy
              </button>
            )}
          </div>
          {people.length ? (
            <div className="task-people">
              {people.map((p) => (
                <section className="card task-person" key={p.id}>
                  <header>
                    <h2>{p.name}</h2>
                    <span className="badge">
                      {p.list.filter((t) => t.completed_at).length}/{p.list.length} realizadas
                    </span>
                  </header>
                  <ul>
                    {p.list.map((t) => (
                      <li key={t.id}>
                        <div>
                          <strong>{t.title}</strong>
                          <small>
                            {t.setup_item_id ? setupLabel(t) : 'Tarea extra'}
                            {t.note ? ` · “${t.note}”` : ''}
                          </small>
                        </div>
                        {t.completed_at ? (
                          <span className="badge">
                            <Check size={13} />
                            Realizada
                          </span>
                        ) : day < workDay ? (
                          <span className="badge danger-badge">No realizada</span>
                        ) : (
                          <span className="badge amber-badge">Pendiente</span>
                        )}
                        <div className="task-row-actions">
                          {t.media_id && (
                            <button className="text-button" onClick={() => onPhoto(t.media_id!)}>
                              Ver foto
                            </button>
                          )}
                          {t.completed_at && day === workDay && (
                            <button
                              className="icon-button"
                              title="Reabrir tarea"
                              aria-label={`Reabrir ${t.title}`}
                              disabled={locked}
                              onClick={() => save(`/tasks/${t.id}/revert`, {})}
                            >
                              <RotateCcw size={15} />
                            </button>
                          )}
                          {!t.setup_item_id && !t.completed_at && !t.media_id && day >= workDay && (
                            <button
                              className="icon-button"
                              title="Quitar tarea extra"
                              aria-label={`Quitar ${t.title}`}
                              disabled={locked}
                              onClick={() => save(`/tasks/${t.id}/delete`, {})}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <section className="card task-empty">
              <p>
                {day === workDay
                  ? 'Todavía nadie tiene tareas hoy. Aparecen cuando cada persona entra a su caja.'
                  : day > workDay
                    ? 'Las tareas de cada caja y turno se asignan ese día, cuando cada persona entra. Aquí solo se ven por adelantado las tareas extra.'
                    : 'No hubo tareas este día.'}
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function DayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="task-days" role="group" aria-label="Días en que se hace">
      {days.map((d) => {
        const on = value.includes(d.value);
        return (
          <button
            type="button"
            key={d.value}
            className={on ? 'active' : ''}
            aria-pressed={on}
            title={d.name}
            onClick={() => onChange(on ? value.filter((v) => v !== d.value) : [...value, d.value])}
          >
            {d.letter}
          </button>
        );
      })}
    </div>
  );
}

function SetupList({
  type,
  target,
  list,
  all,
  locked,
  save,
}: {
  type: (typeof shiftTypes)[number];
  target: Config;
  list: Item[];
  all: Item[];
  locked: boolean;
  save: (path: string, values: Record<string, unknown>) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(''),
    [editing, setEditing] = useState<Item | null>(null),
    [removing, setRemoving] = useState('');
  // Other lists that already have tasks, to start this one from a copy.
  const sources = [
    ...new Map(
      all
        .filter((i) => !same(i, target))
        .map((i) => [`${i.register_number}|${i.shift}|${i.half}`, i]),
    ).values(),
  ].sort((a, b) => a.register_number - b.register_number || typeIndex(a) - typeIndex(b));
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (await save('/tasks/setup', { ...target, title })) setTitle('');
  }
  return (
    <section className="card task-list" data-shift={type.shift}>
      <header>
        {type.shift === 'morning' ? <Sun size={17} /> : <Moon size={17} />}
        <div>
          <h2>{type.name}</h2>
          <small>
            {type.hours} · {list.length === 1 ? '1 tarea' : `${list.length} tareas`}
          </small>
        </div>
      </header>
      {list.length ? (
        <ul>
          {list.map((item) =>
            editing?.id === item.id ? (
              <li key={item.id} className="editing">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await save(`/tasks/setup/${item.id}`, {
                        title: editing.title,
                        weekdays: editing.weekdays,
                      })
                    )
                      setEditing(null);
                  }}
                >
                  <input
                    aria-label="Tarea"
                    value={editing.title}
                    maxLength={200}
                    autoFocus
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  />
                  <DayPicker
                    value={editing.weekdays}
                    onChange={(weekdays) => setEditing({ ...editing, weekdays })}
                  />
                  <div className="task-edit-actions">
                    <button
                      className="primary"
                      disabled={locked || !editing.title.trim() || !editing.weekdays.length}
                    >
                      Guardar
                    </button>
                    <button type="button" className="secondary" onClick={() => setEditing(null)}>
                      Cancelar
                    </button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <small>{daysLabel(item.weekdays)}</small>
                </div>
                {removing === item.id ? (
                  <div className="task-row-actions">
                    <button
                      className="danger-link"
                      disabled={locked}
                      onClick={async () => {
                        await save(`/tasks/setup/${item.id}/delete`, {});
                        setRemoving('');
                      }}
                    >
                      Quitar
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Cancelar"
                      onClick={() => setRemoving('')}
                    >
                      <X size={15} />
                    </button>
                  </div>
                ) : (
                  <div className="task-row-actions">
                    <button
                      className="icon-button"
                      title="Cambiar nombre o días"
                      aria-label={`Editar ${item.title}`}
                      onClick={() => setEditing(item)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      title="Quitar de la lista"
                      aria-label={`Quitar ${item.title}`}
                      onClick={() => setRemoving(item.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="task-none">Sin tareas todavía.</p>
      )}
      <form className="task-add" onSubmit={add}>
        <input
          aria-label={`Nueva tarea para ${type.name}`}
          placeholder="Agregar tarea…"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button className="primary" aria-label="Agregar" disabled={locked || !title.trim()}>
          <Plus size={16} />
        </button>
      </form>
      {sources.length > 0 && (
        <label className="task-copy">
          <Copy size={13} />
          <select
            aria-label={`Copiar tareas a ${type.name}`}
            value=""
            disabled={locked}
            onChange={(e) => {
              const from = sources.find((s) => s.id === e.target.value);
              if (from)
                void save('/tasks/setup/copy', {
                  from: {
                    shift: from.shift,
                    half: from.half,
                    register_number: from.register_number,
                  },
                  to: target,
                });
            }}
          >
            <option value="">Copiar tareas de otra lista…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {setupLabel(s)}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

function ExtraForm({
  users,
  workDay,
  locked,
  onSubmit,
  onCancel,
}: {
  users: Person[];
  workDay: string;
  locked: boolean;
  onSubmit: (v: { user_id: string; title: string; due_date: string }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [userId, setUserId] = useState(''),
    [title, setTitle] = useState(''),
    [date, setDate] = useState(workDay);
  return (
    <section className="card task-extra">
      <div className="card-title">
        <h2>Tarea extra</h2>
        <p>Una tarea ocasional para una persona y un día, aparte de las listas.</p>
      </div>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          await onSubmit({ user_id: userId, title, due_date: date });
        }}
      >
        <div className="fields">
          <div className="field">
            <label htmlFor="extra-user">Persona</label>
            <select
              id="extra-user"
              required
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">Selecciona…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="extra-title">Tarea</label>
            <input
              id="extra-title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="extra-date">Día</label>
            <input
              id="extra-date"
              type="date"
              required
              min={workDay}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
        <div className="task-edit-actions">
          <button className="primary" disabled={locked || !userId || !title.trim()}>
            Asignar tarea
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </form>
    </section>
  );
}
