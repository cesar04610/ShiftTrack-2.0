import { useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, GripVertical, X } from 'lucide-react';
type Person = { id: string; name: string; role: string; active: boolean };
type Schedule = {
  id: string;
  user_id: string;
  business_date: string;
  start_time: string;
  end_time: string;
};
type Shift = 'morning' | 'afternoon';
type Selection = { userId: string; schedule?: Schedule };
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function monday(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -(day === 0 ? 6 : day - 1));
}
const roleNames: Record<string, string> = {
  employee: 'Empleado',
  admin: 'Administrador',
  superadmin: 'Súper administrador',
};
const shiftOf = (s: Schedule): Shift =>
  s.start_time.slice(0, 5) < '15:00' ? 'morning' : 'afternoon';
const halfOf = (s: Schedule) =>
  s.start_time.slice(0, 5) === (shiftOf(s) === 'morning' ? '12:00' : '18:30');
export default function ScheduleBoard({
  users,
  schedules,
  date,
  online,
  onSave,
}: {
  users: Person[];
  schedules: Schedule[];
  date: string;
  online: boolean;
  onSave: (values: {
    id?: string;
    user_id: string;
    business_date: string;
    shift: Shift;
    half: boolean;
  }) => Promise<unknown>;
}) {
  const [week, setWeek] = useState(() => monday(date));
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const dragging = useRef<Selection | null>(null);
  const people = users.filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  async function perform(action: () => Promise<unknown>) {
    if (!online || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setSelection(null);
      setEditing(null);
      dialog.current?.close();
      setNotice('Registro guardado correctamente.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el horario.');
    } finally {
      setBusy(false);
    }
  }
  function assign(targetDate: string, shift: Shift, value = selection) {
    if (!value || !online || busy) return;
    void perform(() =>
      onSave({
        id: value.schedule?.id,
        user_id: value.userId,
        business_date: targetDate,
        shift,
        half: value.schedule ? halfOf(value.schedule) : false,
      }),
    );
  }
  function drag(event: React.DragEvent, value: Selection) {
    event.dataTransfer.setData(
      'application/x-mostrador-schedule',
      JSON.stringify({ userId: value.userId, id: value.schedule?.id }),
    );
    event.dataTransfer.effectAllowed = value.schedule ? 'move' : 'copy';
    dragging.current = value;
  }
  function drop(event: React.DragEvent, targetDate: string, shift: Shift) {
    event.preventDefault();
    if (!online || busy) return;
    try {
      const value = JSON.parse(event.dataTransfer.getData('application/x-mostrador-schedule'));
      if (!people.some((u) => u.id === value.userId)) return;
      const schedule = value.id
        ? schedules.find((s) => s.id === value.id && s.user_id === value.userId)
        : undefined;
      if (value.id && !schedule) return;
      assign(targetDate, shift, { userId: value.userId, schedule });
    } catch {
      /* Only accept a personnel chip from this board. */
    }
  }
  function edit(s: Schedule) {
    setError('');
    setEditing(s);
    dialog.current?.showModal();
  }
  const editingPerson = people.find((u) => u.id === editing?.user_id);
  return (
    <section className="card schedule-board" aria-label="Pizarra semanal de horarios">
      <div className="board-heading">
        <div>
          <span className="eyebrow">ORGANIZA TU EQUIPO</span>
          <h2>Pizarra semanal</h2>
        </div>
        <div className="board-week">
          <button
            className="icon-button"
            aria-label="Semana anterior"
            disabled={busy}
            onClick={() => setWeek(addDays(week, -7))}
          >
            <ChevronLeft size={20} />
          </button>
          <label>
            Semana del
            <input
              type="date"
              value={week}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) setWeek(monday(e.target.value));
              }}
            />
          </label>
          <button
            className="icon-button"
            aria-label="Semana siguiente"
            disabled={busy}
            onClick={() => setWeek(addDays(week, 7))}
          >
            <ChevronRight size={20} />
          </button>
          <button className="secondary" disabled={busy} onClick={() => setWeek(monday(date))}>
            Esta semana
          </button>
        </div>
      </div>
      <p>
        Arrastra una ficha a un turno. También puedes seleccionar a una persona y pulsar «Asignar
        aquí». Selecciona una ficha asignada para cambiarla a medio turno.
      </p>
      {!online && (
        <div className="notice">Conecta a Internet para guardar cambios en los horarios.</div>
      )}
      {error && !editing && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="board-success" role="status">
          {notice}
        </div>
      )}
      {selection && (
        <div className="board-selection">
          Seleccionado: <strong>{people.find((u) => u.id === selection.userId)?.name}</strong>
          <button className="text-button" onClick={() => setSelection(null)}>
            Cancelar selección
          </button>
        </div>
      )}
      <div className="board-scroll">
        <div className="board-days">
          {Array.from({ length: 7 }, (_, i) => {
            const day = addDays(week, i);
            const title = new Intl.DateTimeFormat('es-MX', {
              weekday: 'long',
              timeZone: 'UTC',
            }).format(new Date(`${day}T12:00:00Z`));
            return (
              <section
                className={`board-day ${day === date ? 'today' : ''}`}
                key={day}
                aria-label={`${title} ${day}`}
              >
                <header>
                  <strong>{title}</strong>
                  <span>
                    {new Intl.DateTimeFormat('es-MX', {
                      day: 'numeric',
                      month: 'short',
                      timeZone: 'UTC',
                    }).format(new Date(`${day}T12:00:00Z`))}
                  </span>
                </header>
                {(['morning', 'afternoon'] as const).map((shift) => {
                  const label = shift === 'morning' ? 'Mañana' : 'Tarde';
                  const items = schedules.filter(
                    (s) => s.business_date.slice(0, 10) === day && shiftOf(s) === shift,
                  );
                  return (
                    <div
                      key={shift}
                      className={`board-slot ${selection ? 'accepts-chip' : ''}`}
                      data-date={day}
                      data-shift={shift}
                      onDragOver={(e) => {
                        if (online && !busy) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = dragging.current?.schedule ? 'move' : 'copy';
                        }
                      }}
                      onDrop={(e) => drop(e, day, shift)}
                    >
                      <h3>{label}</h3>
                      <small>{shift === 'morning' ? '07:30 – 15:00' : '15:00 – 21:30'}</small>
                      <div className="board-assigned">
                        {items.map((s) => (
                          <button
                            key={s.id}
                            className={`person-chip assigned ${halfOf(s) ? 'half-shift' : ''}`}
                            disabled={busy || !online}
                            draggable={!busy && online}
                            onDragStart={(e) => drag(e, { userId: s.user_id, schedule: s })}
                            onClick={() => edit(s)}
                            aria-label={`Editar turno de ${users.find((u) => u.id === s.user_id)?.name || 'Personal'} ${title} ${label}`}
                          >
                            <GripVertical size={14} />
                            <strong>
                              {users.find((u) => u.id === s.user_id)?.name || 'Personal no activo'}
                            </strong>
                            <span>
                              {s.start_time.slice(0, 5)} – {s.end_time.slice(0, 5)}
                            </span>
                            {halfOf(s) && <em>Medio turno</em>}
                          </button>
                        ))}
                      </div>
                      <button
                        className="board-assign"
                        disabled={!selection || busy || !online}
                        aria-label={`Asignar a ${title} ${label}`}
                        onClick={() => assign(day, shift)}
                      >
                        Asignar aquí
                      </button>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
      <div className="board-personnel">
        <h3>
          <CalendarDays size={18} />
          Personal de la sucursal
        </h3>
        <div className="personnel-chips">
          {people.map((u) => (
            <button
              key={u.id}
              className={`person-chip ${selection?.userId === u.id && !selection.schedule ? 'chosen' : ''}`}
              disabled={busy || !online}
              draggable={online && !busy}
              aria-label={`Seleccionar a ${u.name}`}
              onDragStart={(e) => drag(e, { userId: u.id })}
              onClick={() => {
                setSelection({ userId: u.id });
                setError('');
              }}
            >
              <GripVertical size={14} />
              <strong>{u.name}</strong>
              <span>{roleNames[u.role]}</span>
            </button>
          ))}
          {!people.length && <p>No hay personal activo para asignar.</p>}
        </div>
      </div>
      <dialog
        ref={dialog}
        className="board-dialog"
        aria-labelledby="board-dialog-title"
        onCancel={(e) => {
          if (busy) e.preventDefault();
          else setEditing(null);
        }}
        onClose={() => setEditing(null)}
      >
        <button
          className="icon-button dialog-close"
          aria-label="Cerrar opciones del turno"
          disabled={busy}
          onClick={() => dialog.current?.close()}
        >
          <X />
        </button>
        <h2 id="board-dialog-title">Turno de {editingPerson?.name || 'personal'}</h2>
        {editing && (
          <>
            <p>
              {editing.business_date.slice(0, 10)} ·{' '}
              {shiftOf(editing) === 'morning' ? 'Mañana' : 'Tarde'}
            </p>
            <p>
              Actual: {editing.start_time.slice(0, 5)} – {editing.end_time.slice(0, 5)}
            </p>
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
            <div className="board-edit-actions">
              {([false, true] as const).map((half) => (
                <button
                  key={String(half)}
                  className={halfOf(editing) === half ? 'primary' : 'secondary'}
                  disabled={busy || !online}
                  onClick={() =>
                    perform(() =>
                      onSave({
                        id: editing.id,
                        user_id: editing.user_id,
                        business_date: editing.business_date.slice(0, 10),
                        shift: shiftOf(editing),
                        half,
                      }),
                    )
                  }
                >
                  {half ? 'Medio turno' : 'Turno completo'}
                  <small>
                    {shiftOf(editing) === 'morning'
                      ? half
                        ? '12:00 – 15:00'
                        : '07:30 – 15:00'
                      : half
                        ? '18:30 – 21:30'
                        : '15:00 – 21:30'}
                  </small>
                </button>
              ))}
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
