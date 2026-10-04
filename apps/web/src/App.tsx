import { useState, useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import {
  Store,
  LayoutDashboard,
  Users,
  CalendarDays,
  ClipboardCheck,
  BarChart3,
  ShoppingBag,
  Receipt,
  Wallet,
  Timer,
  PackageX,
  Settings,
  LogOut,
  KeyRound,
  RefreshCw,
  Wifi,
  WifiOff,
  ArrowUpRight,
  Check,
  Menu,
} from 'lucide-react';
import {
  money,
  parseMoney,
  localTime,
  type User,
  type Command,
} from '../../../packages/domain/index.js';
import { request, ApiError, download, imageUrl, hasOnlineSession } from './api';
import {
  login,
  logout,
  snapshot,
  enqueue,
  sync,
  listPending,
  getDevice,
  db,
  expiresAt,
  selectRegister,
  preparedRegister,
  type Pending,
} from './offline';
type Field = {
  name: string;
  label: string;
  type?: string;
  options?: { value: string; label: string }[];
  value?: string;
  optional?: boolean;
  placeholder?: string;
  onChange?: (value: string) => void;
};
function Form({
  fields,
  onSubmit,
  label = 'Guardar',
  children,
}: {
  fields: Field[];
  onSubmit: (data: Record<string, string>) => Promise<void>;
  label?: string;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    formId = useId();
  const operation = useRef(crypto.randomUUID());
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        ...Object.fromEntries(new FormData(form)),
        operation_id: operation.current,
      } as Record<string, string>);
      operation.current = crypto.randomUUID();
      form.reset();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="form">
      <div className="fields">
        {fields.map((f) => (
          <div className="field" key={f.name}>
            <label htmlFor={`${formId}-${f.name}`}>{f.label}</label>
            {f.options ? (
              <select
                id={`${formId}-${f.name}`}
                name={f.name}
                required={!f.optional}
                defaultValue={f.value || ''}
              >
                <option value="" disabled>
                  Seleccionar…
                </option>
                {f.options.map((x) => (
                  <option value={x.value} key={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${formId}-${f.name}`}
                name={f.name}
                type={f.type || 'text'}
                defaultValue={f.value}
                onChange={(e) => f.onChange?.(e.target.value)}
                placeholder={f.placeholder}
                required={!f.optional}
                step={f.type === 'number' ? '0.01' : undefined}
                autoComplete={f.type === 'password' ? 'current-password' : 'off'}
              />
            )}
          </div>
        ))}
      </div>
      {children}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="primary" disabled={busy}>
        {busy ? 'Guardando…' : label}
      </button>
    </form>
  );
}
function Card({
  title,
  children,
  subtitle,
}: {
  title: string;
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <section className="card">
      <div className="card-title">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}
function Empty({ text = 'Aún no hay registros.' }: { text?: string }) {
  return (
    <div className="empty">
      <ClipboardCheck size={30} />
      <p>{text}</p>
    </div>
  );
}
function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return rows.length ? (
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
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty />
  );
}
const adminNav = [
  ['Inicio', LayoutDashboard],
  ['Usuarios', Users],
  ['Horarios', CalendarDays],
  ['Tareas', ClipboardCheck],
  ['Reportes', BarChart3],
  ['Alertas', BarChart3],
  ['Caja proveedores', Wallet],
  ['Cortes', Receipt],
  ['Caja general', Wallet],
  ['Configuración', Settings],
] as const;
const employeeNav = [
  ['Horario', CalendarDays],
  ['Registro de entradas', Timer],
  ['Tareas', ClipboardCheck],
  ['Caja proveedores', Wallet],
  ['Faltantes', PackageX],
  ['Mi corte', Receipt],
] as const;
const labels: Record<string, string> = {
  superadmin: 'Superadministrador',
  admin: 'Administrador',
  employee: 'Empleado',
};
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [branches, setBranches] = useState<any[]>([]),
    [branchId, setBranchId] = useState(''),
    [registerNumber, setRegisterNumber] = useState<number | null>(null),
    [allBranches, setAllBranches] = useState<any[]>([]),
    [deletingBranch, setDeletingBranch] = useState<any>(null),
    [newRegisterCount, setNewRegisterCount] = useState(1),
    [addingSupplier, setAddingSupplier] = useState(false),
    [occupiedRegisters, setOccupiedRegisters] = useState<any[]>([]),
    [releasingRegister, setReleasingRegister] = useState<number | null>(null),
    [data, setData] = useState<any>(null),
    [page, setPage] = useState('Inicio'),
    [pending, setPending] = useState<Pending[]>([]),
    [online, setOnline] = useState(navigator.onLine),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [mobile, setMobile] = useState(false),
    [prepared, setPrepared] = useState(false),
    [deviceId, setDeviceId] = useState(''),
    [now, setNow] = useState(Date.now());
  const notify = (e: unknown) => setMessage(e instanceof Error ? e.message : String(e));
  async function refresh(remote = true) {
    if (!user || !branchId) return;
    const loaded = await snapshot(user, branchId, remote);
    if (user.role !== 'employee' && remote)
      loaded.analytics = await request(`/analytics?branch_id=${branchId}`);
    setData(loaded);
    setPending(await listPending());
  }
  async function synchronize() {
    setBusy(true);
    try {
      await sync();
      await refresh();
      setOnline(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NETWORK') setOnline(false);
      else notify(e);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (user && branchId) {
      refresh().catch(notify);
    }
  }, [user, branchId]);
  useEffect(() => {
    const listener = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && user) synchronize();
    };
    window.addEventListener('online', listener);
    window.addEventListener('offline', listener);
    window.addEventListener('focus', listener);
    const interval = setInterval(() => {
      setNow(Date.now());
      if (user) synchronize();
    }, 30_000);
    return () => {
      window.removeEventListener('online', listener);
      window.removeEventListener('offline', listener);
      window.removeEventListener('focus', listener);
      clearInterval(interval);
    };
  }, [user, branchId]);
  useEffect(() => {
    if (user?.role === 'superadmin' && page === 'Configuración')
      request('/branches?include_archived=true').then(setAllBranches).catch(notify);
    if (user && user.role !== 'employee' && page === 'Configuración' && branchId)
      request(`/registers?branch_id=${branchId}`).then(setOccupiedRegisters).catch(notify);
  }, [user, page, branchId]);
  useEffect(() => {
    if (user?.role !== 'employee' || !registerNumber || !online || !hasOnlineSession()) return;
    const renew = async () => {
      try {
        await request('/registers/heartbeat', { register_number: registerNumber });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NETWORK') setOnline(false);
        else {
          setRegisterNumber(null);
          setMessage((e as Error).message);
        }
      }
    };
    renew();
    const interval = setInterval(renew, 30_000);
    return () => clearInterval(interval);
  }, [user, registerNumber, online]);
  async function signIn(values: Record<string, string>) {
    const result = await login(values.username, values.password);
    setRegisterNumber(null);
    setData(null);
    setUser(result.user);
    setPrepared(result.prepared);
    setDeviceId((await getDevice()).id);
    setOnline(!result.offline);
    setPage(result.user.role === 'employee' ? 'Horario' : 'Inicio');
    let list;
    if (result.offline) {
      const cached = (await db.caches.get(`branches:${result.user.id}`))?.value;
      list = cached || [];
    } else {
      list = await request('/branches');
      await db.caches.put({ id: `branches:${result.user.id}`, value: list });
    }
    setBranches(list);
    setBranchId(result.user.branch_id || list[0]?.id || '');
    setPending(await listPending());
  }
  async function signOut() {
    await logout();
    setRegisterNumber(null);
    setUser(null);
    setData(null);
    setPrepared(false);
    setMessage('');
  }
  async function mutate(path: string, values: any) {
    await request(path, { ...values, branch_id: branchId });
    await refresh();
    setMessage('Registro guardado correctamente.');
  }
  async function command(type: Command['type'], values: Record<string, string>, photo?: Blob) {
    if (online && !hasOnlineSession())
      throw new Error(
        'Inicia sesión nuevamente con conexión para validar tu caja antes de capturar nuevos movimientos. Tus pendientes se conservan.',
      );
    await enqueue(type, values, user!, branchId, photo);
    await refresh(false);
    setMessage('Registro guardado correctamente.');
    synchronize();
  }
  const expired = !!expiresAt() && Date.parse(expiresAt()!) <= now;
  if (!user)
    return (
      <div className="login-page">
        <div className="login-brand">
          <div className="brand-icon">
            <Store size={30} />
          </div>
          <h1>
            ShiftTrack <span>2.0</span>
          </h1>
          <p>Tu operación, en orden.</p>
        </div>
        <div className="login-card">
          <h2>Bienvenido</h2>
          <p>Ingresa con tu usuario y contraseña.</p>
          <Form
            fields={[
              { name: 'username', label: 'Usuario', placeholder: 'Nombre de usuario' },
              { name: 'password', label: 'Contraseña', type: 'password' },
            ]}
            onSubmit={signIn}
            label="Iniciar sesión"
          />
          <div className="login-note">
            <span className={online ? 'dot' : 'dot amber'} />
            {online ? 'Acceso conectado' : 'Sin conexión · acceso previamente preparado'}
          </div>
        </div>
        <p className="login-footer">Turnos · Tareas · Proveedores · Caja</p>
      </div>
    );
  const isAdmin = user.role !== 'employee',
    employeeOptions = (data?.users || [])
      .filter((u: any) => u.role === 'employee' && u.active)
      .map((u: any) => ({ value: u.id, label: u.name }));
  const nav = isAdmin
    ? adminNav
    : employeeNav.filter(
        ([label]) =>
          !['Proveedores', 'Caja proveedores'].includes(label) ||
          (prepared && registerNumber === data?.branch.supplier_register),
      );
  const b = data?.branch,
    deviceReady = prepared && registerNumber === b?.supplier_register;
  const treasury = data?.treasury || [],
    cash = treasury.reduce((s: bigint, t: any) => s + BigInt(t.cash_cents), 0n),
    bank = treasury.reduce((s: bigint, t: any) => s + BigInt(t.bank_cents), 0n);
  const date = b ? localTime(new Date(), b.timezone).date : new Date().toISOString().slice(0, 10);
  const meta: Record<string, string> = {
    Inicio: 'Un vistazo a la operación de tu sucursal.',
    Usuarios: 'Cuentas, permisos y conservación del historial.',
    Horarios: 'Organiza los turnos de tu equipo.',
    Horario: 'Consulta tus próximos turnos.',
    Tareas: 'Lo que hay que hacer, en un solo lugar.',
    Proveedores: 'Directorio y pagos de proveedores.',
    'Caja proveedores': 'Registra pagos y consulta los tickets de proveedores.',
    Cortes: 'Ventas, efectivo contado y diferencias.',
    'Mi corte': 'Registra el efectivo de ventas de este turno.',
    'Caja general': 'Efectivo y banco, con movimientos trazables.',
    'Registro de entradas': 'Registra tu entrada y salida del día.',
    Faltantes: 'Productos que hacen falta en la sucursal.',
    Configuración: 'Sucursales, cajas y accesos preparados.',
    Reportes: 'Consulta la actividad registrada de esta sucursal.',
  };
  const supplierForm = (
    <Form
      fields={[
        { name: 'company', label: 'Empresa' },
        { name: 'representative', label: 'Representante', optional: true },
        { name: 'phone', label: 'Teléfono', optional: true },
        { name: 'product_type', label: 'Tipo de producto', optional: true },
      ]}
      label="Agregar proveedor"
      onSubmit={async (v) => {
        await command('supplier.create', { id: crypto.randomUUID(), ...v });
        setAddingSupplier(false);
      }}
    />
  );
  return (
    <div className={`app ${isAdmin ? '' : 'employee-app'}`}>
      <aside className={mobile ? 'sidebar show' : 'sidebar'}>
        <div className="sidebar-brand">
          <div className="brand-icon">
            <Store size={23} />
          </div>
          <div>
            <strong>
              ShiftTrack <em>2.0</em>
            </strong>
            <small>{isAdmin ? 'Panel administrativo' : 'Mi espacio de trabajo'}</small>
          </div>
        </div>
        <p className="nav-caption">OPERACIÓN</p>
        <nav>
          {nav.map(([label, Icon]) => (
            <button
              key={label}
              className={page === label ? 'selected' : ''}
              onClick={() => {
                setPage(label);
                setMobile(false);
                setMessage('');
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setPage('Contraseña')}>
            <KeyRound size={17} />
            Cambiar contraseña
          </button>
          <div className="profile">
            <span>
              {user.name
                .split(' ')
                .map((s) => s[0])
                .slice(0, 2)
                .join('')}
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>{labels[user.role]}</small>
            </div>
          </div>
          <button onClick={signOut}>
            <LogOut size={17} />
            Cerrar sesión
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label="Abrir menú"
              onClick={() => setMobile(!mobile)}
            >
              <Menu />
            </button>
            <Store size={18} />
            {user.role === 'superadmin' ? (
              <select
                aria-label="Sucursal"
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  setData(null);
                }}
              >
                {branches.map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{branches.find((x) => x.id === branchId)?.name || 'Sucursal'}</strong>
            )}
          </div>
          <div className="topbar-right">
            {!isAdmin && registerNumber && <strong>Caja {registerNumber}</strong>}
            <span className={`connection ${online ? '' : 'offline'}`}>
              {online ? <Wifi size={15} /> : <WifiOff size={15} />}{' '}
              {online ? 'Conectado' : 'Sin conexión'}
            </span>
            <button
              className="icon-button"
              title="Sincronizar y actualizar"
              aria-label="Sincronizar y actualizar"
              disabled={busy}
              onClick={synchronize}
            >
              <RefreshCw size={17} className={busy ? 'spin' : ''} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">{isAdmin ? 'ADMINISTRACIÓN' : 'OPERACIÓN DIARIA'}</span>
              <h1>{!isAdmin && !registerNumber ? 'Selecciona la caja en la que estás' : page}</h1>
              <p>{meta[page]}</p>
            </div>
            <span className="date-label">
              {new Intl.DateTimeFormat('es-MX', {
                dateStyle: 'medium',
                timeZone: b?.timezone || 'America/Mazatlan',
              }).format(new Date())}
            </span>
          </div>
          {message && (
            <div className="notice" role="status">
              {message}
              <button aria-label="Cerrar aviso" onClick={() => setMessage('')}>
                ×
              </button>
            </div>
          )}
          {b?.active === false && (
            <div className="notice">
              Esta sucursal fue eliminada. Estás consultando su historial; no se permiten nuevas
              operaciones.
            </div>
          )}
          {(b?.pause_token || b?.local_paused) && (
            <div className="notice">
              Caja proveedores detenida para corrección administrativa. Sincroniza para confirmar
              pendientes y recibir la nueva versión.
            </div>
          )}
          {expired && (
            <div className="error">
              Acceso offline vencido. Inicia sesión con conexión para renovarlo. Tus pendientes se
              conservan.
            </div>
          )}
          {!isAdmin && !!registerNumber && online && !hasOnlineSession() && (
            <div className="notice">
              Recuperaste la conexión. Los pendientes pueden sincronizarse; inicia sesión de nuevo
              para validar la ocupación de tu caja antes de registrar nuevos movimientos.
            </div>
          )}
          {!isAdmin && !!registerNumber && !prepared && (
            <div className="notice">
              Este equipo aún no tiene tu acceso offline preparado. Puedes consultar horarios y
              registrar tu entrada con conexión. Para habilitar las capturas operativas, usa un
              equipo registrado por el dueño en tu misma sucursal.
            </div>
          )}
          {pending.length > 0 && (
            <details className="pending-panel">
              <summary>
                {pending.some((x) => x.state === 'needs_review' || x.state === 'blocked')
                  ? 'Hay operaciones que requieren revisión'
                  : `${pending.length} registro(s) guardado(s) correctamente`}
              </summary>
              {pending.map((x) => (
                <div key={x.id}>
                  <strong>{x.command.type}</strong>
                  <span>
                    {x.state === 'needs_review'
                      ? 'Requiere revisión'
                      : x.state === 'blocked'
                        ? 'Dependencia pendiente'
                        : 'Pendiente'}{' '}
                    · {x.message || x.command.occurred_at}
                  </span>
                </div>
              ))}
              <button
                className="secondary"
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(
                    new Blob([JSON.stringify(pending, null, 2)], { type: 'application/json' }),
                  );
                  a.download = 'shifttrack-pendientes.json';
                  a.click();
                  URL.revokeObjectURL(a.href);
                }}
              >
                Descargar respaldo de comandos pendientes
              </button>
              <p>No incluye claves de acceso. Conserva también los datos de este navegador.</p>
            </details>
          )}
          {!isAdmin && !registerNumber ? (
            <Card title="Caja de trabajo">
              <p>
                {online
                  ? 'Selecciona tu caja. Si otra sesión ya la ocupa, el sistema te pedirá elegir otra.'
                  : 'Sin conexión no se puede comprobar si otra persona ocupa la caja. Solo puedes usar la última caja que preparaste con Internet.'}
              </p>
              <Form
                fields={[
                  {
                    name: 'register_number',
                    label: 'Selecciona tu caja',
                    options: online
                      ? Array.from(
                          {
                            length:
                              b?.register_count ||
                              branches.find((x) => x.id === branchId)?.register_count ||
                              1,
                          },
                          (_, i) => ({
                            value: String(i + 1),
                            label: `Caja ${i + 1}${i + 1 === b?.supplier_register ? ' · Proveedores' : ''}`,
                          }),
                        )
                      : preparedRegister()
                        ? [
                            {
                              value: String(preparedRegister()),
                              label: `Caja ${preparedRegister()}`,
                            },
                          ]
                        : [],
                  },
                ]}
                label="Entrar a esta caja"
                onSubmit={async (v) => {
                  const number = Number(v.register_number);
                  const result = await selectRegister(number, online);
                  setRegisterNumber(number);
                  setPrepared(result.prepared);
                  setDeviceId((await getDevice(branchId)).id);
                  await refresh(online);
                }}
              />
            </Card>
          ) : !data && page !== 'Configuración' ? (
            <Card title="Preparando datos">
              <p>Conecta para descargar la información de tu sucursal.</p>
            </Card>
          ) : (
            <>
              {page === 'Inicio' && (
                <>
                  <div className="stats">
                    <Stat
                      title="Efectivo general"
                      value={money(cash)}
                      foot="Contado de ventas y movimientos"
                      icon={<Wallet />}
                    />
                    <Stat
                      title="Saldo bancario"
                      value={money(bank)}
                      foot="Tarjeta y movimientos de banco"
                      icon={<Receipt />}
                    />
                    <Stat
                      title="Caja proveedores"
                      value={money(b.balance_cents)}
                      foot={`Caja ${b.supplier_register} · ${b.active_shift ? 'Turno abierto' : 'Sin turno abierto'}`}
                      icon={<ShoppingBag />}
                    />
                    <Stat
                      title="Tareas pendientes"
                      value={String(data.tasks.filter((t: any) => !t.completed_at).length)}
                      foot="Asignadas al equipo"
                      icon={<ClipboardCheck />}
                    />
                  </div>
                  <div className="grid">
                    <Card title="Actividad reciente" subtitle="Últimos movimientos de caja general">
                      <Table
                        headers={['Concepto', 'Efectivo', 'Banco']}
                        rows={treasury
                          .slice(-6)
                          .reverse()
                          .map((t: any) => [t.note, money(t.cash_cents), money(t.bank_cents)])}
                      />
                    </Card>
                    <Card title="Tu sucursal">
                      <div className="branch-info">
                        <div className="branch-symbol">
                          <Store size={34} />
                        </div>
                        <h3>{b.name}</h3>
                        <p>{b.timezone}</p>
                        <span className="badge">
                          {b.initialized ? 'Saldos inicializados' : 'Apertura pendiente'}
                        </span>
                      </div>
                      <button className="text-button" onClick={() => setPage('Caja general')}>
                        Ver caja general <ArrowUpRight size={15} />
                      </button>
                    </Card>
                  </div>
                  <Card title="Turnos del día">
                    <Table
                      headers={['Empleado', 'Entrada', 'Salida']}
                      rows={data.clock
                        .filter((r: any) => r.business_date.slice(0, 10) === date)
                        .map((r: any) => [
                          data.users.find((u: any) => u.id === r.user_id)?.name || r.user_id,
                          time(r.clock_in, b.timezone),
                          r.clock_out ? (
                            time(r.clock_out, b.timezone)
                          ) : (
                            <span className="badge">En turno</span>
                          ),
                        ])}
                    />
                  </Card>
                </>
              )}
              {page === 'Usuarios' && (
                <>
                  <Card title="Crear cuenta">
                    <Form
                      fields={[
                        { name: 'name', label: 'Nombre' },
                        { name: 'username', label: 'Usuario', placeholder: 'Único, sin espacios' },
                        {
                          name: 'role',
                          label: 'Rol',
                          options: (user.role === 'superadmin'
                            ? ['employee', 'admin', 'superadmin']
                            : ['employee']
                          ).map((v) => ({ value: v, label: labels[v] })),
                        },
                        {
                          name: 'password',
                          label: 'Contraseña inicial · mínimo 12 caracteres',
                          type: 'password',
                        },
                      ]}
                      label="Crear usuario"
                      onSubmit={(v) => mutate('/users', v)}
                    />
                  </Card>
                  <Card title="Equipo de la sucursal">
                    <Table
                      headers={['Nombre', 'Usuario', 'Rol', 'Estado', '']}
                      rows={data.users.map((u: any) => [
                        u.name,
                        u.username,
                        labels[u.role],
                        u.active ? 'Activo' : 'Inactivo',
                        u.active &&
                        u.id !== user.id &&
                        (user.role === 'superadmin' || u.role === 'employee') ? (
                          <button
                            className="danger-link"
                            onClick={() => mutate(`/users/${u.id}/deactivate`, {}).catch(notify)}
                          >
                            Desactivar
                          </button>
                        ) : null,
                      ])}
                    />
                  </Card>
                </>
              )}
              {(page === 'Horarios' || page === 'Horario') && (
                <>
                  {isAdmin && (
                    <Card title="Programar turno">
                      <Form
                        fields={[
                          { name: 'user_id', label: 'Empleado', options: employeeOptions },
                          { name: 'business_date', label: 'Fecha', type: 'date', value: date },
                          { name: 'start_time', label: 'Entrada', type: 'time' },
                          { name: 'end_time', label: 'Salida', type: 'time' },
                        ]}
                        onSubmit={(v) => mutate('/schedules', v)}
                      />
                    </Card>
                  )}
                  {isAdmin && (
                    <Card title="Copiar semana">
                      <Form
                        fields={[
                          { name: 'source_date', label: 'Inicio de semana origen', type: 'date' },
                          { name: 'target_date', label: 'Inicio de semana destino', type: 'date' },
                        ]}
                        label="Copiar horarios"
                        onSubmit={(v) => mutate('/schedules/clone', v)}
                      />
                    </Card>
                  )}
                  <Card title={isAdmin ? 'Horarios del equipo' : 'Mi horario'}>
                    <Table
                      headers={['Fecha', 'Empleado', 'Entrada', 'Salida']}
                      rows={data.schedules.map((s: any) => [
                        s.business_date.slice(0, 10),
                        isAdmin ? data.users.find((u: any) => u.id === s.user_id)?.name : user.name,
                        s.start_time.slice(0, 5),
                        s.end_time.slice(0, 5),
                      ])}
                    />
                  </Card>
                </>
              )}
              {page === 'Registro de entradas' && (
                <>
                  <Card title="Mi turno de hoy">
                    <div className="clock-display">
                      <Timer size={42} />
                      <h2>
                        {data.clock.some((r: any) => !r.clock_out)
                          ? 'Tu turno está en curso'
                          : 'Listo para registrar tu turno'}
                      </h2>
                      <p>Entrada y salida dentro del mismo día de la sucursal.</p>
                      <div className="button-row">
                        <button
                          className="primary"
                          disabled={!online}
                          onClick={() => mutate('/clock/in', {}).catch(notify)}
                        >
                          Registrar entrada
                        </button>
                        <button
                          className="secondary"
                          disabled={!online}
                          onClick={() => mutate('/clock/out', {}).catch(notify)}
                        >
                          Registrar salida
                        </button>
                      </div>
                    </div>
                  </Card>
                  <Card title="Mis registros de entrada y salida">
                    <Table
                      headers={['Fecha', 'Entrada', 'Salida', 'Horas']}
                      rows={data.clock.map((r: any) => [
                        r.business_date.slice(0, 10),
                        time(r.clock_in, b.timezone),
                        r.clock_out ? time(r.clock_out, b.timezone) : 'En curso',
                        r.clock_out
                          ? ((Date.parse(r.clock_out) - Date.parse(r.clock_in)) / 3600000).toFixed(
                              2,
                            )
                          : '—',
                      ])}
                    />
                  </Card>
                </>
              )}
              {page === 'Tareas' && (
                <>
                  {isAdmin && (
                    <Card title="Asignar tarea">
                      <Form
                        fields={[
                          { name: 'title', label: 'Tarea' },
                          { name: 'user_id', label: 'Empleado', options: employeeOptions },
                          { name: 'due_date', label: 'Fecha', type: 'date', value: date },
                          {
                            name: 'priority',
                            label: 'Prioridad',
                            options: [
                              { value: 'normal', label: 'Normal' },
                              { value: 'alta', label: 'Alta' },
                            ],
                          },
                        ]}
                        onSubmit={(v) => mutate('/tasks', v)}
                      />
                    </Card>
                  )}
                  {isAdmin && (
                    <div className="grid">
                      <Card title="Catálogo de tareas">
                        <Form
                          fields={[
                            { name: 'title', label: 'Nombre de plantilla' },
                            { name: 'description', label: 'Descripción', optional: true },
                            {
                              name: 'priority',
                              label: 'Prioridad',
                              options: [
                                { value: 'normal', label: 'Normal' },
                                { value: 'alta', label: 'Alta' },
                              ],
                            },
                          ]}
                          label="Crear plantilla"
                          onSubmit={(v) => mutate('/tasks/catalog', v)}
                        />
                      </Card>
                      <Card title="Asignación recurrente">
                        <Form
                          fields={[
                            {
                              name: 'catalog_id',
                              label: 'Plantilla',
                              options: (data.catalog || [])
                                .filter((t: any) => t.active)
                                .map((t: any) => ({ value: t.id, label: t.title })),
                            },
                            { name: 'user_id', label: 'Empleado', options: employeeOptions },
                            {
                              name: 'recurrence',
                              label: 'Recurrencia',
                              options: [
                                { value: 'once', label: 'Una vez' },
                                { value: 'daily', label: 'Diaria' },
                                { value: 'weekly', label: 'Semanal' },
                              ],
                            },
                            {
                              name: 'start_date',
                              label: 'Fecha inicial',
                              type: 'date',
                              value: date,
                            },
                            {
                              name: 'weekdays',
                              label: 'Días semanales (0 domingo, 1 lunes … 6 sábado)',
                              optional: true,
                              placeholder: '1,2,3,4,5',
                            },
                          ]}
                          label="Asignar recurrencia"
                          onSubmit={(v) =>
                            mutate('/tasks/assignments', {
                              ...v,
                              weekdays: v.weekdays ? v.weekdays.split(',').map(Number) : [],
                            })
                          }
                        />
                      </Card>
                    </div>
                  )}
                  <div className="tasks-list">
                    {data.tasks.length ? (
                      data.tasks.map((t: any) => (
                        <Card
                          key={t.id}
                          title={t.title}
                          subtitle={`${t.due_date.slice(0, 10)} · Prioridad ${t.priority}`}
                        >
                          <div className="task-state">
                            {t.completed_at ? (
                              <span className="badge">
                                <Check size={14} />
                                Completada
                              </span>
                            ) : (
                              <span className="badge amber-badge">Pendiente</span>
                            )}
                            {isAdmin && (
                              <span>{data.users.find((u: any) => u.id === t.user_id)?.name}</span>
                            )}
                          </div>
                          {t.note && <p>{t.note}</p>}
                          {!isAdmin && !t.completed_at && (
                            <PhotoForm
                              onSubmit={(note, photo) =>
                                command('task.complete', { id: t.id, note }, photo)
                              }
                            />
                          )}
                          {isAdmin && t.completed_at && (
                            <button
                              className="text-button"
                              onClick={() => mutate(`/tasks/${t.id}/revert`, {}).catch(notify)}
                            >
                              Reabrir tarea
                            </button>
                          )}
                          {t.media_id && (
                            <button
                              className="text-button"
                              onClick={async () => {
                                try {
                                  const local = await db.media.get(t.media_id);
                                  const url = local
                                    ? URL.createObjectURL(local.blob)
                                    : await imageUrl(t.media_id, branchId);
                                  const win = window.open(url, '_blank', 'noopener');
                                  setTimeout(() => URL.revokeObjectURL(url), 60000);
                                } catch (e) {
                                  notify(e);
                                }
                              }}
                            >
                              Ver fotografía
                            </button>
                          )}
                        </Card>
                      ))
                    ) : (
                      <Card title="Tareas">
                        <Empty text="No hay tareas asignadas." />
                      </Card>
                    )}
                  </div>
                </>
              )}
              {page === 'Caja proveedores' && (
                <>
                  {!isAdmin && (
                    <div className="supplier-actions">
                      <button className="secondary" onClick={() => setAddingSupplier(true)}>
                        Agregar proveedores
                      </button>
                    </div>
                  )}
                  {addingSupplier && (
                    <div className="modal-backdrop">
                      <section
                        className="supplier-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="supplier-dialog-title"
                      >
                        <h2 id="supplier-dialog-title">Agregar proveedor</h2>
                        {supplierForm}
                        <button className="secondary" onClick={() => setAddingSupplier(false)}>
                          Cancelar
                        </button>
                      </section>
                    </div>
                  )}
                  {!isAdmin && (
                    <Card title="Registrar pago">
                      <Form
                        fields={[
                          {
                            name: 'supplier_id',
                            label: 'Proveedor',
                            options: data.suppliers
                              .filter((s: any) => s.active)
                              .map((s: any) => ({ value: s.id, label: s.company })),
                          },
                          { name: 'amount', label: 'Importe · MXN', type: 'number' },
                          { name: 'note', label: 'Nota', optional: true },
                        ]}
                        label="Guardar ticket"
                        onSubmit={(v) =>
                          command('supplier.ticket.create', {
                            id: crypto.randomUUID(),
                            supplier_id: v.supplier_id,
                            amount_cents: parseMoney(v.amount),
                            note: v.note,
                          })
                        }
                      />
                    </Card>
                  )}
                  {isAdmin && (
                    <>
                      <div className="grid">
                        <Card title="Directorio de proveedores">
                          <Table
                            headers={['Empresa', 'Representante', 'Teléfono', 'Producto']}
                            rows={data.suppliers
                              .filter((s: any) => s.active)
                              .map((s: any) => [
                                s.company,
                                s.representative || s.contact || '—',
                                s.phone || '—',
                                s.product_type || '—',
                              ])}
                          />
                        </Card>
                      </div>
                    </>
                  )}
                  {isAdmin && (
                    <Card title="Corrección después del cierre">
                      <p>
                        Conserva el pago original y registra motivo y compensación. Primero detén la
                        caja y espera confirmación del equipo designado.
                      </p>
                      {!b.pause_token ? (
                        <button
                          className="secondary"
                          onClick={() =>
                            mutate('/supplier-corrections/prepare', {})
                              .then(() => synchronize())
                              .catch(notify)
                          }
                        >
                          Solicitar pausa de caja para corregir
                        </button>
                      ) : (
                        <>
                          <p>
                            {b.pause_ack
                              ? 'Equipo detenido y sincronizado. Puedes registrar la corrección.'
                              : 'Esperando que el equipo designado se conecte, sincronice sus pendientes y confirme la pausa.'}
                          </p>
                          <button
                            className="text-button"
                            onClick={() => mutate('/supplier-corrections/cancel', {}).catch(notify)}
                          >
                            Cancelar pausa
                          </button>
                          {b.pause_ack && (
                            <Form
                              fields={[
                                {
                                  name: 'ticket_id',
                                  label: 'Ticket original',
                                  options: (data.tickets || [])
                                    .filter(
                                      (t: any) =>
                                        !t.voided &&
                                        (data.shifts || []).some(
                                          (sh: any) => sh.id === t.shift_id && sh.closed_at,
                                        ),
                                    )
                                    .map((t: any) => ({
                                      value: t.id,
                                      label: `${data.suppliers.find((s: any) => s.id === t.supplier_id)?.company} · ${money(t.amount_cents)}`,
                                    })),
                                },
                                {
                                  name: 'type',
                                  label: 'Tipo de corrección',
                                  options: [
                                    {
                                      value: 'documentary',
                                      label:
                                        'Rectificación documental: sin ingreso a caja proveedores',
                                    },
                                    {
                                      value: 'refund',
                                      label: 'Devolución física: ingreso a proveedores',
                                    },
                                  ],
                                },
                                {
                                  name: 'amount',
                                  label: 'Importe a corregir · MXN',
                                  type: 'number',
                                },
                                { name: 'reason', label: 'Motivo de corrección' },
                              ]}
                              label="Registrar compensación"
                              onSubmit={(v) =>
                                mutate('/supplier-corrections', {
                                  ticket_id: v.ticket_id,
                                  type: v.type,
                                  amount_cents: parseMoney(v.amount),
                                  reason: v.reason,
                                  pause_token: b.pause_token,
                                })
                              }
                            />
                          )}
                        </>
                      )}
                    </Card>
                  )}
                  <Card title="Tickets de compra y pago">
                    <Table
                      headers={['Fecha', 'Proveedor', 'Importe', 'Estado', 'Nota', '']}
                      rows={(data.tickets || []).map((t: any) => [
                        time(t.occurred_at, b.timezone),
                        data.suppliers.find((s: any) => s.id === t.supplier_id)?.company,
                        money(t.amount_cents),
                        t.voided ? 'Anulado' : 'Registrado',
                        t.note,
                        !isAdmin && !t.voided && t.actor_user_id === user.id ? (
                          <Form
                            fields={[{ name: 'reason', label: 'Motivo' }]}
                            label="Anular"
                            onSubmit={(v) =>
                              command('supplier.ticket.void', { id: t.id, reason: v.reason })
                            }
                          />
                        ) : null,
                      ])}
                    />
                  </Card>
                </>
              )}
              {page === 'Caja proveedores' && !isAdmin && (
                <>
                  <div className="stats">
                    <Stat
                      title="Saldo esperado"
                      value={money(b.balance_cents)}
                      foot={`Caja ${b.supplier_register} · ${b.name}`}
                      icon={<Wallet />}
                    />
                    <Stat
                      title="Responsable"
                      value={
                        b.active_shift?.actor_user_id === user.id
                          ? user.name
                          : b.active_shift
                            ? 'Otro empleado'
                            : 'Sin turno abierto'
                      }
                      foot={
                        b.active_shift
                          ? 'Cierra con conteo para entregar'
                          : 'El siguiente responsable recibe el último contado'
                      }
                      icon={<Users />}
                    />
                  </div>
                  <div className="grid">
                    {!b.active_shift ? (
                      <Card title="Recibir caja">
                        <p>Recibirás {money(b.balance_cents)} del último conteo.</p>
                        <button
                          className="primary"
                          onClick={() =>
                            command('supplier.shift.open', { id: crypto.randomUUID() }).catch(
                              notify,
                            )
                          }
                        >
                          Abrir mi turno
                        </button>
                      </Card>
                    ) : (
                      <Card
                        title={
                          b.active_shift.business_date.slice(0, 10) < date
                            ? 'Reconciliar cierre pendiente'
                            : 'Cerrar y entregar turno'
                        }
                      >
                        <p>Cuenta el efectivo real. La diferencia se conserva en el historial.</p>
                        <Form
                          fields={[
                            { name: 'counted', label: 'Efectivo contado · MXN', type: 'number' },
                          ]}
                          label="Confirmar conteo y cierre"
                          onSubmit={(v) =>
                            command(
                              b.active_shift.business_date.slice(0, 10) < date
                                ? 'supplier.shift.reconcile'
                                : 'supplier.shift.close',
                              { counted_cents: parseMoney(v.counted) },
                            )
                          }
                        />
                      </Card>
                    )}
                    <Card title="Agregar efectivo a proveedores">
                      <p>Es un traslado interno: no aumenta el efectivo total del negocio.</p>
                      <Form
                        fields={[
                          { name: 'amount', label: 'Importe · MXN', type: 'number' },
                          { name: 'note', label: 'Nota', optional: true },
                        ]}
                        onSubmit={(v) =>
                          command('supplier.balance.add', {
                            amount_cents: parseMoney(v.amount),
                            note: v.note,
                          })
                        }
                      />
                    </Card>
                  </div>
                  <Card title="Cierres y diferencias">
                    <Table
                      headers={['Fecha', 'Esperado', 'Contado', 'Diferencia']}
                      rows={(data.shifts || [])
                        .filter((s: any) => s.closed_at)
                        .map((s: any) => [
                          time(s.closed_at, b.timezone),
                          money(s.expected_cents),
                          money(s.counted_cents),
                          money(s.difference_cents),
                        ])}
                    />
                  </Card>
                  <div className="notice">
                    Para relevarte: cierra con conteo, sal de tu sesión y permite que el entrante
                    ingrese con su propio usuario. Su acceso debe estar preparado y vigente.
                  </div>
                </>
              )}
              {page === 'Faltantes' && (
                <>
                  <Card title="Reportar producto faltante">
                    <Form
                      fields={[
                        { name: 'product', label: 'Producto' },
                        { name: 'note', label: 'Nota', optional: true },
                      ]}
                      label="Registrar faltante"
                      onSubmit={(v) =>
                        command('shortage.create', { id: crypto.randomUUID(), ...v })
                      }
                    />
                  </Card>
                  <Card title="Faltantes de la sucursal">
                    <Table
                      headers={['Producto', 'Nota', 'Fecha']}
                      rows={data.shortages.map((s: any) => [
                        s.product,
                        s.note,
                        time(s.occurred_at, b.timezone),
                      ])}
                    />
                  </Card>
                </>
              )}
              {(page === 'Mi corte' || page === 'Cortes') && (
                <>
                  {!isAdmin && (
                    <Card title="Capturar mi corte">
                      <p>
                        El corte corresponde a tu registro de entrada. Mañana: desde las 05:00 hasta
                        antes de las 15:00. Tarde: desde las 15:00 hasta antes de las 05:00 del día
                        siguiente. La hora de cierre no cambia el turno.
                      </p>
                      <Form
                        fields={[
                          { name: 'sales', label: 'Ventas totales · MXN', type: 'number' },
                          { name: 'card', label: 'Pagos con tarjeta · MXN', type: 'number' },
                          {
                            name: 'declared',
                            label: 'Efectivo contado de ventas · MXN',
                            type: 'number',
                          },
                        ]}
                        label="Guardar corte"
                        onSubmit={(v) =>
                          command('cut.create', {
                            id: crypto.randomUUID(),
                            register_number: String(registerNumber),
                            sales_cents: parseMoney(v.sales),
                            card_cents: parseMoney(v.card),
                            declared_cents: parseMoney(v.declared),
                          })
                        }
                      />
                    </Card>
                  )}
                  <Card title="Cortes registrados">
                    <Table
                      headers={['Fecha', 'Turno', 'Ventas', 'Tarjeta', 'Contado', 'Diferencia']}
                      rows={data.cuts.map((c: any) => [
                        c.business_date.slice(0, 10),
                        c.label,
                        money(c.sales_cents),
                        money(c.card_cents),
                        money(c.declared_cents),
                        money(c.difference_cents || c.difference || '0'),
                      ])}
                    />
                  </Card>
                </>
              )}
              {page === 'Caja general' && (
                <>
                  {!b.initialized ? (
                    <Card title="Saldos de arranque">
                      <p>
                        Proveedores es una parte del efectivo total, no un saldo adicional. No se
                        importan movimientos anteriores.
                      </p>
                      <Form
                        fields={[
                          { name: 'cash', label: 'Efectivo total · MXN', type: 'number' },
                          {
                            name: 'supplier',
                            label: 'Parte en caja proveedores · MXN',
                            type: 'number',
                          },
                          { name: 'bank', label: 'Saldo bancario · MXN', type: 'number' },
                        ]}
                        label="Registrar apertura"
                        onSubmit={(v) =>
                          mutate('/treasury/opening', {
                            cash_cents: parseMoney(v.cash),
                            supplier_cents: parseMoney(v.supplier),
                            bank_cents: parseMoney(v.bank),
                          })
                        }
                      />
                    </Card>
                  ) : (
                    <>
                      <div className="stats">
                        <Stat
                          title="Efectivo general"
                          value={money(cash)}
                          foot="Incluye el efectivo de proveedores"
                          icon={<Wallet />}
                        />
                        <Stat
                          title="Banco"
                          value={money(bank)}
                          foot="Tarjetas, retiros y ajustes"
                          icon={<Receipt />}
                        />
                        <Stat
                          title="Total del negocio"
                          value={money(cash + bank)}
                          foot="Efectivo + banco"
                          icon={<BarChart3 />}
                        />
                      </div>
                      <Card title="Nuevo movimiento">
                        <Form
                          fields={[
                            {
                              name: 'kind',
                              label: 'Movimiento',
                              options: [
                                { value: 'expense', label: 'Gasto extraordinario' },
                                { value: 'bank_withdrawal', label: 'Retiro de banco a efectivo' },
                                { value: 'cash_adjustment', label: 'Ajuste de efectivo' },
                                { value: 'bank_adjustment', label: 'Ajuste de banco' },
                              ],
                            },
                            { name: 'amount', label: 'Importe · MXN', type: 'number' },
                            { name: 'note', label: 'Concepto / motivo' },
                          ]}
                          onSubmit={(v) => {
                            const negative = v.amount.startsWith('-');
                            return mutate('/treasury/movements', {
                              kind: v.kind,
                              operation_id: v.operation_id,
                              amount_cents: `${negative ? '-' : ''}${parseMoney(v.amount.replace(/^-/, ''))}`,
                              note: v.note,
                            });
                          }}
                        />
                      </Card>
                    </>
                  )}
                  <Card title="Historial de caja general">
                    <Table
                      headers={['Fecha', 'Concepto', 'Efectivo', 'Banco']}
                      rows={[...treasury]
                        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
                        .map((t: any) => [
                          time(t.occurred_at, b.timezone),
                          t.note,
                          money(t.cash_cents),
                          money(t.bank_cents),
                        ])}
                    />
                  </Card>
                </>
              )}
              {page === 'Reportes' && (
                <>
                  <button
                    className="primary export-button"
                    onClick={() =>
                      download(
                        `/reports/export?branch_id=${branchId}`,
                        'shifttrack-reportes.xlsx',
                      ).catch(notify)
                    }
                  >
                    Exportar Excel
                  </button>
                  <Card title="Asistencia registrada">
                    <Table
                      headers={['Empleado', 'Fecha', 'Entrada', 'Salida', 'Horas']}
                      rows={data.clock.map((r: any) => [
                        data.users.find((u: any) => u.id === r.user_id)?.name,
                        r.business_date.slice(0, 10),
                        time(r.clock_in, b.timezone),
                        r.clock_out ? time(r.clock_out, b.timezone) : 'En curso',
                        r.clock_out
                          ? ((Date.parse(r.clock_out) - Date.parse(r.clock_in)) / 3600000).toFixed(
                              2,
                            )
                          : '—',
                      ])}
                    />
                  </Card>
                  <Card
                    title="Horarios sin registro de entrada recibido"
                    subtitle="La ausencia de un registro no confirma ausencia física; puede haber pendientes sin sincronizar."
                  >
                    <Table
                      headers={['Empleado', 'Fecha', 'Horario']}
                      rows={(data.analytics?.absences || []).map((r: any) => [
                        r.name,
                        r.business_date.slice(0, 10),
                        `${r.start_time} – ${r.end_time}`,
                      ])}
                    />
                  </Card>
                  <Card title="Auditoría de operaciones">
                    <Table
                      headers={['Acción', 'Fecha de recepción', 'Empleado']}
                      rows={data.audit.map((a: any) => [
                        a.action,
                        time(a.received_at, b.timezone),
                        data.users.find((u: any) => u.id === a.actor_user_id)?.name ||
                          a.actor_user_id,
                      ])}
                    />
                  </Card>
                  <Card title="Compras por proveedor">
                    <Table
                      headers={['Proveedor', 'Tickets', 'Compras brutas', 'Neto tras correcciones']}
                      rows={(data.analytics?.spending || []).map((r: any) => [
                        r.company,
                        r.tickets,
                        money(r.gross_cents),
                        money(r.net_cents),
                      ])}
                    />
                  </Card>
                  <Card title="Tendencia diaria de cortes">
                    <Table
                      headers={['Fecha', 'Ventas', 'Tarjeta', 'Contado', 'Diferencia']}
                      rows={(data.analytics?.daily || []).map((r: any) => [
                        r.business_date.slice(0, 10),
                        money(r.sales_cents),
                        money(r.card_cents),
                        money(r.declared_cents),
                        money(r.difference_cents),
                      ])}
                    />
                  </Card>
                  <Card title="Promedios por empleado, caja y día">
                    <Table
                      headers={['Empleado', 'Caja', 'Día', 'Muestras', 'Promedio de ventas']}
                      rows={(data.analytics?.baselines || []).map((r: any) => [
                        r.name,
                        r.register_number,
                        ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][
                          r.weekday
                        ],
                        r.samples,
                        money(r.average_cents),
                      ])}
                    />
                  </Card>
                </>
              )}
              {page === 'Alertas' && (
                <>
                  <Card title="Configuración de avisos">
                    <Form
                      fields={[
                        {
                          name: 'absence_tolerance_minutes',
                          label: 'Tolerancia de ausencia · minutos',
                          type: 'number',
                          value: String(data.alert_settings?.absence_tolerance_minutes || 15),
                        },
                        {
                          name: 'cut_delay_minutes',
                          label: 'Demora de corte · minutos',
                          type: 'number',
                          value: String(data.alert_settings?.cut_delay_minutes || 30),
                        },
                        {
                          name: 'recipients',
                          label: 'Destinatarios de correo · separados por coma',
                          optional: true,
                          value: (data.alert_settings?.recipients || []).join(','),
                        },
                        {
                          name: 'email_enabled',
                          label: 'Envío de correos',
                          value: data.alert_settings?.email_enabled ? 'yes' : 'no',
                          options: [
                            { value: 'no', label: 'Deshabilitado' },
                            { value: 'yes', label: 'Habilitado · verificar SMTP del servidor' },
                          ],
                        },
                      ]}
                      onSubmit={(v) =>
                        mutate('/alerts/settings', {
                          absence_tolerance_minutes: Number(v.absence_tolerance_minutes),
                          cut_delay_minutes: Number(v.cut_delay_minutes),
                          recipients: v.recipients
                            ? v.recipients.split(',').map((s) => s.trim())
                            : [],
                          email_enabled: v.email_enabled === 'yes',
                        })
                      }
                    />
                    <p>
                      El envío de correos requiere configuración y prueba de SMTP antes de
                      habilitarse.
                    </p>
                  </Card>
                  <Card title="Avisos de la sucursal">
                    <Table
                      headers={['Tipo', 'Aviso', 'Estado', '']}
                      rows={(data.alerts || []).map((a: any) => [
                        a.type,
                        a.message,
                        a.resolved ? 'Resuelto' : a.seen ? 'Visto' : 'Nuevo',
                        !a.seen && (
                          <button
                            className="text-button"
                            onClick={() => mutate(`/alerts/${a.id}/seen`, {}).catch(notify)}
                          >
                            Marcar visto
                          </button>
                        ),
                      ])}
                    />
                  </Card>
                  <Card title="Historial de correo">
                    <Table
                      headers={['Asunto', 'Estado', 'Intentos', 'Detalle', '']}
                      rows={(data.notifications || []).map((n: any) => [
                        n.subject,
                        n.status,
                        n.attempts,
                        n.last_error || '—',
                        ['failed', 'needs_review'].includes(n.status) && (
                          <Form
                            fields={[{ name: 'reason', label: 'Motivo de reintento' }]}
                            label="Reintentar envío"
                            onSubmit={(v) => mutate(`/notifications/${n.id}/retry`, v)}
                          />
                        ),
                      ])}
                    />
                    <p>
                      Un envío aceptado por SMTP no garantiza entrega al buzón. Reintentar una
                      entrega incierta puede duplicar un correo.
                    </p>
                  </Card>
                </>
              )}
              {page === 'Configuración' && (
                <>
                  {user.role === 'superadmin' ? (
                    <>
                      <Card title="Sucursales">
                        <Table
                          headers={['Sucursal', 'Cajas', 'Proveedores', 'Estado', '']}
                          rows={allBranches.map((branch) => [
                            branch.name,
                            branch.register_count,
                            `Caja ${branch.supplier_register}`,
                            branch.active ? 'Activa' : 'Eliminada · historial conservado',
                            branch.active ? (
                              <button
                                className="secondary"
                                onClick={() => setDeletingBranch(branch)}
                              >
                                Eliminar sucursal
                              </button>
                            ) : (
                              <button
                                className="secondary"
                                onClick={() => {
                                  setBranches((prev) =>
                                    prev.some((x) => x.id === branch.id) ? prev : [...prev, branch],
                                  );
                                  setBranchId(branch.id);
                                  setPage('Reportes');
                                }}
                              >
                                Ver historial
                              </button>
                            ),
                          ])}
                        />
                      </Card>
                      {deletingBranch && (
                        <Card title={`Eliminar sucursal ${deletingBranch.name}`}>
                          <p>
                            ¿Realmente quieres eliminar esta sucursal? Se bloqueará el acceso de sus
                            usuarios y equipos. Sus movimientos, usuarios y fotografías se
                            conservarán como historial.
                          </p>
                          <Form
                            fields={[
                              {
                                name: 'password',
                                label: 'Tu contraseña de superadministrador',
                                type: 'password',
                              },
                            ]}
                            label="Confirmar eliminación"
                            onSubmit={async (v) => {
                              await request(`/branches/${deletingBranch.id}/deactivate`, {
                                password: v.password,
                              });
                              const list = await request('/branches');
                              setBranches(list);
                              setAllBranches(await request('/branches?include_archived=true'));
                              if (branchId === deletingBranch.id) {
                                setData(null);
                                setBranchId(list[0]?.id || '');
                              }
                              setDeletingBranch(null);
                              setMessage('Sucursal eliminada. Su historial se conserva.');
                            }}
                          />
                          <button className="secondary" onClick={() => setDeletingBranch(null)}>
                            Cancelar
                          </button>
                        </Card>
                      )}
                      <Card title="Crear sucursal">
                        <Form
                          fields={[
                            { name: 'name', label: 'Nombre de sucursal' },
                            { name: 'timezone', label: 'Zona horaria', value: 'America/Mazatlan' },
                            {
                              name: 'register_count',
                              label: 'Cantidad de cajas',
                              type: 'number',
                              value: '1',
                              onChange: (value) =>
                                setNewRegisterCount(
                                  Math.max(1, Math.min(100, Math.floor(Number(value)) || 1)),
                                ),
                            },
                            {
                              name: 'supplier_register',
                              label: 'Caja de proveedores',
                              options: Array.from({ length: newRegisterCount }, (_, i) => ({
                                value: String(i + 1),
                                label: `Caja ${i + 1}`,
                              })),
                              value: '1',
                            },
                          ]}
                          label="Crear sucursal"
                          onSubmit={async (v) => {
                            await request('/branches', {
                              ...v,
                              register_count: Number(v.register_count),
                              supplier_register: Number(v.supplier_register),
                            });
                            const list = await request('/branches');
                            setBranches(list);
                            setAllBranches(await request('/branches?include_archived=true'));
                            if (!branchId) setBranchId(list[0]?.id || '');
                            setNewRegisterCount(1);
                            setMessage('Registro guardado correctamente.');
                          }}
                        />
                      </Card>
                    </>
                  ) : (
                    <Card title="Configuración de sucursal">
                      <p>El dueño administra las sucursales y sus cajas.</p>
                    </Card>
                  )}
                </>
              )}
              {page === 'Configuración' && isAdmin && b?.active && (
                <Card title="Cajas ocupadas">
                  <p>
                    Las cajas permanecen asignadas hasta cerrar sesión. Si un empleado dejó una
                    sesión abierta, puedes liberarla con tu contraseña. Sus movimientos e historial
                    se conservan.
                  </p>
                  <Table
                    headers={['Caja', 'Empleado', 'Acción']}
                    rows={occupiedRegisters.map((r) => [
                      `Caja ${r.register_number}`,
                      r.name,
                      <button
                        className="secondary"
                        onClick={() => setReleasingRegister(r.register_number)}
                      >
                        Liberar caja {r.register_number}
                      </button>,
                    ])}
                  />
                  {releasingRegister && (
                    <>
                      <div className="notice warning">
                        Vas a liberar la caja {releasingRegister} y cerrar la sesión que la ocupa.
                        Confirma con tu contraseña.
                      </div>
                      <Form
                        fields={[{ name: 'password', label: 'Tu contraseña', type: 'password' }]}
                        label="Confirmar liberación"
                        onSubmit={async (v) => {
                          await mutate(`/registers/${releasingRegister}/release`, v);
                          setReleasingRegister(null);
                          setOccupiedRegisters(await request(`/registers?branch_id=${branchId}`));
                        }}
                      />
                      <button className="secondary" onClick={() => setReleasingRegister(null)}>
                        Cancelar
                      </button>
                    </>
                  )}
                </Card>
              )}
              {page === 'Contraseña' && (
                <Card title="Cambiar mi contraseña">
                  <Form
                    fields={[
                      { name: 'old_password', label: 'Contraseña actual', type: 'password' },
                      {
                        name: 'password',
                        label: 'Nueva contraseña · mínimo 12 caracteres',
                        type: 'password',
                      },
                    ]}
                    label="Actualizar y salir"
                    onSubmit={async (v) => {
                      await request('/auth/change-password', v);
                      await signOut();
                    }}
                  />
                </Card>
              )}
            </>
          )}
          <footer className="app-footer">
            ShiftTrack 2.0 · {b?.name || 'Selecciona una sucursal'}
            {!isAdmin && prepared && (
              <span>Acceso offline preparado · Caja {registerNumber || preparedRegister()}</span>
            )}
          </footer>
        </main>
      </div>
    </div>
  );
}
function Stat({
  title,
  value,
  foot,
  icon,
}: {
  title: string;
  value: string;
  foot: string;
  icon: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span>{title}</span>
        <i>{icon}</i>
      </div>
      <strong>{value}</strong>
      <p>{foot}</p>
    </div>
  );
}
function time(value: string, zone: string) {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: zone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function PhotoForm({ onSubmit }: { onSubmit: (note: string, photo?: Blob) => Promise<void> }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    id = useId();
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        setBusy(true);
        const form = e.currentTarget,
          data = new FormData(form),
          photo = data.get('photo') as File;
        try {
          await onSubmit(String(data.get('note') || ''), photo?.size ? photo : undefined);
          form.reset();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="fields">
        <div className="field">
          <label htmlFor={`${id}-note`}>Nota de finalización</label>
          <input id={`${id}-note`} name="note" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-photo`}>Fotografía opcional · máximo 5 MiB</label>
          <input
            id={`${id}-photo`}
            name="photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
          />
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="primary" disabled={busy}>
        {busy ? 'Guardando…' : 'Completar tarea'}
      </button>
    </form>
  );
}
