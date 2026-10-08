import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Maximize2,
  Minimize2,
  Moon,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
type Person = { id: string; name: string; role: string; active: boolean };
type Schedule = {
  id: string;
  user_id: string;
  business_date: string;
  start_time: string;
  end_time: string;
  position?: number;
};
type Shift = 'morning' | 'afternoon';
type Selection = { userId: string; schedule?: Schedule };
type Hover = { day: string; shift: Shift; index: number };
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
const byPlace = (a: Schedule, b: Schedule) =>
  (a.position ?? 0) - (b.position ?? 0) ||
  a.start_time.localeCompare(b.start_time) ||
  a.id.localeCompare(b.id);
const halfOf = (s: Schedule) =>
  s.start_time.slice(0, 5) === (shiftOf(s) === 'morning' ? '12:00' : '18:30');
export default function ScheduleBoard({
  users,
  schedules,
  date,
  online,
  onSave,
  onRemove,
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
    index?: number;
  }) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const board = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [week, setWeek] = useState(() => monday(date));
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const dragging = useRef<Selection | null>(null);
  const editing = schedules.find((s) => s.id === editingId) || null;
  const slotOf = (day: string, shift: Shift) =>
    schedules
      .filter((s) => s.business_date.slice(0, 10) === day && shiftOf(s) === shift)
      .sort(byPlace);
  const people = users.filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    expandButton.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (dialog.current?.open) return;
      if (event.key === 'Escape') {
        setExpanded(false);
        expandButton.current?.focus();
      }
      if (event.key === 'Tab') {
        const controls = Array.from(
          board.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled)',
          ) || [],
        ).filter((el) => el.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', keyboard);
    };
  }, [expanded]);
  function shortName(person?: Person) {
    if (!person) return 'Personal';
    const parts = person.name.trim().split(/\s+/);
    const repeated = users.some(
      (u) =>
        u.id !== person.id &&
        u.name.trim().split(/\s+/)[0].toLocaleLowerCase('es') === parts[0].toLocaleLowerCase('es'),
    );
    return parts[0] + (repeated && parts[1] ? ` ${parts[1][0]}.` : '');
  }
  function chipStyle(id: string): CSSProperties {
    // The ID keeps each person's color unchanged across days, shifts and reloads.
    const hues = [48, 330, 210, 145, 275, 28, 175, 5, 85, 245, 190, 305];
    let hash = 0;
    for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    const hue = hues[hash % hues.length];
    return {
      '--chip-bg': `hsl(${hue} 88% 91%)`,
      '--chip-border': `hsl(${hue} 65% 65%)`,
      '--chip-text': `hsl(${hue} 60% 24%)`,
    } as CSSProperties;
  }
  async function perform(action: () => Promise<unknown>, keepOpen = false) {
    if (!online || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setSelection(null);
      if (!keepOpen) {
        setEditingId(null);
        dialog.current?.close();
      }
      setNotice('Registro guardado correctamente.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el horario.');
    } finally {
      setBusy(false);
    }
  }
  function assign(targetDate: string, shift: Shift, value = selection, index?: number) {
    if (!value || !online || busy) return;
    const rest = slotOf(targetDate, shift).filter((s) => s.id !== value.schedule?.id);
    void perform(() =>
      onSave({
        id: value.schedule?.id,
        user_id: value.userId,
        business_date: targetDate,
        shift,
        half: value.schedule ? halfOf(value.schedule) : false,
        index: index ?? rest.length,
      }),
    );
  }
  // Chooses the place under the pointer, ignoring the chip that is being moved.
  function placeUnder(event: React.DragEvent<HTMLElement>, day: string, shift: Shift): Hover {
    const chips = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('.person-chip.assigned:not(.is-dragged)'),
    );
    let index = 0;
    for (const chip of chips) {
      const box = chip.getBoundingClientRect();
      if (event.clientY > box.top + box.height / 2) index += 1;
    }
    return { day, shift, index };
  }
  function drag(event: React.DragEvent, value: Selection) {
    event.dataTransfer.setData(
      'application/x-mostrador-schedule',
      JSON.stringify({ userId: value.userId, id: value.schedule?.id }),
    );
    event.dataTransfer.effectAllowed = value.schedule ? 'move' : 'copy';
    dragging.current = value;
    // Hiding the origin chip after the browser captured its image keeps the slot readable.
    const origin = event.currentTarget as HTMLElement;
    requestAnimationFrame(() => origin.classList.add('is-dragged'));
  }
  function endDrag(event: React.DragEvent) {
    (event.currentTarget as HTMLElement).classList.remove('is-dragged');
    dragging.current = null;
    setHover(null);
  }
  function drop(event: React.DragEvent<HTMLElement>, targetDate: string, shift: Shift) {
    event.preventDefault();
    const target = placeUnder(event, targetDate, shift);
    setHover(null);
    if (!online || busy) return;
    try {
      const value = JSON.parse(event.dataTransfer.getData('application/x-mostrador-schedule'));
      if (!people.some((u) => u.id === value.userId)) return;
      const schedule = value.id
        ? schedules.find((s) => s.id === value.id && s.user_id === value.userId)
        : undefined;
      if (value.id && !schedule) return;
      assign(targetDate, shift, { userId: value.userId, schedule }, target.index);
    } catch {
      /* Only accept a personnel chip from this board. */
    }
  }
  function edit(s: Schedule) {
    setError('');
    setConfirmRemove(false);
    setEditingId(s.id);
    dialog.current?.showModal();
  }
  const editingPerson = people.find((u) => u.id === editing?.user_id);
  return (
    <section
      ref={board}
      className={`card schedule-board ${expanded ? 'is-expanded' : ''}`}
      aria-label="Pizarra semanal de horarios"
    >
      <div className="board-heading">
        <div>
          <h2>Pizarra semanal</h2>
        </div>
        <div className="board-week">
          <button
            ref={expandButton}
            className="secondary board-expand"
            aria-pressed={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            {expanded ? 'Reducir pizarra' : 'Ampliar pizarra'}
          </button>
          <button
            className="icon-button"
            aria-label="Semana anterior"
            disabled={busy}
            onClick={() => setWeek(addDays(week, -7))}
          >
            <ChevronLeft size={20} />
          </button>
          <label>
            <span className="board-date-label">Semana del</span>
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
      <p className="board-hint">
        Arrastra una ficha y suéltala en el lugar exacto del turno, arriba o abajo de otra. En el
        celular selecciona una persona y pulsa +. Toca un turno para cambiar el horario o subirlo y
        bajarlo.
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
                  <strong title={title}>
                    <span className="day-long">{title}</span>
                    <span className="day-short">{title.slice(0, 3)}</span>
                  </strong>
                  <span className="day-number">{Number(day.slice(8, 10))}</span>
                </header>
                {(['morning', 'afternoon'] as const).map((shift) => {
                  const label = shift === 'morning' ? 'Mañana' : 'Tarde';
                  const items = slotOf(day, shift);
                  const rest = items.filter((s) => s.id !== dragging.current?.schedule?.id);
                  const over = hover?.day === day && hover.shift === shift ? hover.index : -1;
                  return (
                    <div
                      key={shift}
                      className={`board-slot ${selection ? 'accepts-chip' : ''} ${over >= 0 ? 'is-over' : ''}`}
                      data-date={day}
                      data-shift={shift}
                      onDragOver={(e) => {
                        if (online && !busy) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = dragging.current?.schedule ? 'move' : 'copy';
                          const next = placeUnder(e, day, shift);
                          setHover((h) =>
                            h &&
                            h.day === next.day &&
                            h.shift === next.shift &&
                            h.index === next.index
                              ? h
                              : next,
                          );
                        }
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                          setHover(null);
                      }}
                      onDrop={(e) => drop(e, day, shift)}
                    >
                      <h3>
                        {shift === 'morning' ? <Sun size={11} /> : <Moon size={11} />}
                        <span>{label}</span>
                      </h3>
                      <div className="board-assigned">
                        {items.map((s) => (
                          <button
                            key={s.id}
                            className={`person-chip assigned ${halfOf(s) ? 'half-shift' : ''} ${
                              over >= 0 && rest[over]?.id === s.id ? 'drop-before' : ''
                            } ${over >= 0 && over === rest.length && rest.at(-1)?.id === s.id ? 'drop-after' : ''}`}
                            style={chipStyle(s.user_id)}
                            title={`${users.find((u) => u.id === s.user_id)?.name || 'Personal no activo'} · ${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}${halfOf(s) ? ' · Medio turno' : ''}`}
                            disabled={busy || !online}
                            draggable={!busy && online}
                            onDragStart={(e) => drag(e, { userId: s.user_id, schedule: s })}
                            onDragEnd={endDrag}
                            onClick={() => edit(s)}
                            aria-label={`Editar turno de ${users.find((u) => u.id === s.user_id)?.name || 'Personal'} ${title} ${label}`}
                          >
                            <strong>{shortName(users.find((u) => u.id === s.user_id))}</strong>
                            <span className="chip-time">
                              {s.start_time.slice(0, 5)}–<wbr />
                              {s.end_time.slice(0, 5)}
                            </span>
                            {halfOf(s) && (
                              <em className="half-marker" title="Medio turno">
                                ½
                              </em>
                            )}
                          </button>
                        ))}
                      </div>
                      <button
                        className="board-assign"
                        disabled={!selection || busy || !online}
                        aria-label={`Asignar a ${title} ${label}`}
                        onClick={() => assign(day, shift)}
                      >
                        +
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
              style={chipStyle(u.id)}
              title={`${u.name} · ${roleNames[u.role]}`}
              disabled={busy || !online}
              draggable={online && !busy}
              aria-label={`Seleccionar a ${u.name}`}
              onDragStart={(e) => drag(e, { userId: u.id })}
              onDragEnd={endDrag}
              onClick={() => {
                setSelection({ userId: u.id });
                setError('');
              }}
            >
              <strong>{shortName(u)}</strong>
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
          else setEditingId(null);
        }}
        onClose={() => setEditingId(null)}
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
            {(() => {
              const slot = slotOf(editing.business_date.slice(0, 10), shiftOf(editing));
              const at = slot.findIndex((s) => s.id === editing.id);
              const move = (index: number) =>
                perform(
                  () =>
                    onSave({
                      id: editing.id,
                      user_id: editing.user_id,
                      business_date: editing.business_date.slice(0, 10),
                      shift: shiftOf(editing),
                      half: halfOf(editing),
                      index,
                    }),
                  true,
                );
              return (
                <div className="board-order">
                  <span>
                    Lugar en el turno: {at + 1} de {slot.length}
                  </span>
                  <button
                    className="secondary"
                    disabled={busy || !online || at <= 0}
                    onClick={() => move(at - 1)}
                  >
                    <ChevronUp size={16} /> Subir
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || !online || at >= slot.length - 1}
                    onClick={() => move(at + 1)}
                  >
                    <ChevronDown size={16} /> Bajar
                  </button>
                </div>
              );
            })()}
            <div className="board-remove">
              {confirmRemove ? (
                <>
                  <span>¿Quitar a {editingPerson?.name || 'esta persona'} de este turno?</span>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setConfirmRemove(false)}
                  >
                    Cancelar
                  </button>
                  <button
                    className="danger"
                    disabled={busy || !online}
                    onClick={() => perform(() => onRemove(editing.id))}
                  >
                    Sí, quitar
                  </button>
                </>
              ) : (
                <button
                  className="danger-outline"
                  disabled={busy || !online}
                  onClick={() => setConfirmRemove(true)}
                >
                  <Trash2 size={15} /> Quitar del turno
                </button>
              )}
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
