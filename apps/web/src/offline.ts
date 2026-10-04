import Dexie, { type Table } from 'dexie';
import {
  canonical,
  assert,
  cents,
  localTime,
  cutAmounts,
  shiftLabel,
  shiftBusinessDate,
  type Command,
  type User,
} from '../../../packages/domain/index.js';
import { request, onlineLogin, logoutSession, ApiError } from './api';
type Meta = { id: string; value: any };
export type Pending = {
  id: string;
  command: Command;
  state: 'pending' | 'sending' | 'confirmed' | 'needs_review' | 'blocked';
  message?: string;
  result?: any;
};
type Prepared = {
  username: string;
  user: User;
  grant: any;
  salt: string;
  iv: string;
  encrypted: string;
  lastWall: number;
  offset: number;
};
class LocalDB extends Dexie {
  meta!: Table<Meta, string>;
  users!: Table<Prepared, string>;
  outbox!: Table<Pending, string>;
  caches!: Table<Meta, string>;
  media!: Table<{ id: string; blob: Blob; confirmed: boolean }, string>;
  constructor() {
    super('shifttrack-v1');
    this.version(1).stores({ meta: 'id', users: 'username', outbox: 'id,state', caches: 'id' });
    this.version(2).stores({ media: 'id' });
  }
}
export const db = new LocalDB();
const bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const b64 = (data: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(data)));
const encoding = new TextEncoder();
let privateKey: CryptoKey | null = null,
  session: Prepared | null = null,
  clockAnchor: { server: number; mono: number } | null = null;
let releaseWriter: (() => void) | null = null;
const curve = { name: 'ECDSA', namedCurve: 'P-256' };
async function passwordKey(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoding.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 310000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function signature(body: unknown, key: CryptoKey) {
  return b64(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      encoding.encode(canonical(body)),
    ),
  );
}
export async function getDevice(branchId?: string) {
  branchId ||= session?.user.branch_id || onlineCredentials?.user.branch_id || undefined;
  if (branchId) {
    const scoped = await db.meta.get(`device:${branchId}`);
    if (scoped) return scoped.value;
  }
  let stored = await db.meta.get('device');
  if (stored) return stored.value;
  const pair = await crypto.subtle.generateKey(curve, false, ['sign', 'verify']);
  const device = {
    id: crypto.randomUUID(),
    private_key: pair.privateKey,
    public_key: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
  await db.meta.put({ id: 'device', value: device });
  return device;
}
async function activateWriter() {
  if (releaseWriter) return;
  assert(
    navigator.locks,
    'UNSUPPORTED',
    'Este navegador no admite exclusión de pestañas. Usa Chrome o Edge.',
  );
  await new Promise<void>((resolve, reject) => {
    navigator.locks
      .request('shifttrack-active-employee', { ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(
            new Error(
              'Otra pestaña tiene la sesión operativa abierta. Ciérrala antes de continuar.',
            ),
          );
          return;
        }
        await new Promise<void>((done) => {
          releaseWriter = done;
          resolve();
        });
      })
      .catch(reject);
  });
}
let onlineCredentials: { user: User; password: string } | null = null;
async function prepareEmployee(user: User, password: string) {
  const device = await getDevice(user.branch_id!);
  const username = user.username;
  await activateWriter();
  const pair = await crypto.subtle.generateKey(curve, true, ['sign', 'verify']);
  try {
    const grant = await request('/devices/user-grants', {
      device_id: device.id,
      password,
      public_key: await crypto.subtle.exportKey('jwk', pair.publicKey),
    });
    const serverKey = await crypto.subtle.importKey('jwk', grant.server_public_key, curve, false, [
      'verify',
    ]);
    assert(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        serverKey,
        bytes(grant.signature),
        encoding.encode(canonical(grant.body)),
      ),
      'BAD_GRANT',
      'No se pudo verificar la autorización del servidor.',
    );
    const salt = crypto.getRandomValues(new Uint8Array(16)),
      iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await passwordKey(password, salt),
      jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoding.encode(JSON.stringify({ key: jwk, check: 'shifttrack-v1' })),
    );
    session = {
      username,
      user,
      grant,
      salt: b64(salt),
      iv: b64(iv),
      encrypted: b64(encrypted),
      lastWall: Date.now(),
      offset: Date.parse(grant.body.issued_at) - Date.now(),
    };
    await db.users.put(session);
    privateKey = pair.privateKey;
    clockAnchor = { server: Date.parse(grant.body.issued_at), mono: performance.now() };
    await db.meta.put({ id: 'wall-highwater', value: Date.now() });
    await navigator.storage?.persist();
  } catch (e) {
    // A valid online session does not require an offline grant on this device.
    if (
      e instanceof ApiError &&
      (e.code === 'DEVICE_NOT_ASSIGNED' || e.code === 'DEVICE_BRANCH_MISMATCH')
    ) {
      session = null;
      privateKey = null;
      releaseWriter?.();
      releaseWriter = null;
    } else throw e;
  }
}
export function preparedRegister(): number | undefined {
  return session?.grant.body.register_number ?? undefined;
}
export async function selectRegister(registerNumber: number, connected: boolean) {
  if (!connected) {
    assert(
      session && privateKey && preparedRegister() === registerNumber,
      'REGISTER_NOT_PREPARED',
      'Sin conexión solo puedes usar la caja que preparaste al iniciar sesión con Internet.',
    );
    await trustedNow();
    return { prepared: true };
  }
  const branchId = onlineCredentials?.user.branch_id || session?.user.branch_id;
  const device = await getDevice(branchId || undefined);
  const alreadyWriter = !!releaseWriter;
  await activateWriter();
  try {
    const lease = await request('/registers/select', {
      register_number: registerNumber,
      device_id: device.id,
      public_key: device.public_key,
    });
    if (branchId && lease.device_id)
      await db.meta.put({ id: `device:${branchId}`, value: { ...device, id: lease.device_id } });
    if (onlineCredentials) {
      const credentials = onlineCredentials;
      await prepareEmployee(credentials.user, credentials.password);
      onlineCredentials = null;
    } else
      assert(
        !session || preparedRegister() === registerNumber,
        'REGISTER_NOT_PREPARED',
        'Inicia sesión de nuevo para preparar otra caja.',
      );
    return { prepared: !!session };
  } catch (error) {
    if (!alreadyWriter) {
      releaseWriter?.();
      releaseWriter = null;
    }
    throw error;
  }
}

export async function login(username: string, password: string) {
  username = username.trim().toLowerCase();
  try {
    const result = await onlineLogin(username, password),
      device = await getDevice();
    const user = result.user as User;
    clockAnchor = { server: Date.parse(result.server_time), mono: performance.now() };
    onlineCredentials = user.role === 'employee' ? { user, password } : null;
    session = null;
    privateKey = null;
    return { user, prepared: !!session, offline: false };
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'NETWORK')) {
      await logout();
      throw e;
    }
    const prepared = await db.users.get(username);
    assert(
      prepared,
      'NOT_PREPARED',
      'Este empleado necesita iniciar sesión con conexión en este equipo.',
    );
    const attempts = (await db.meta.get(`attempts:${username}`))?.value || { count: 0, until: 0 };
    assert(
      Date.now() >= attempts.until,
      'RATE_LIMIT',
      'Espera un minuto antes de volver a intentar.',
    );
    try {
      const key = await passwordKey(password, bytes(prepared.salt));
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes(prepared.iv) },
        key,
        bytes(prepared.encrypted),
      );
      const data = JSON.parse(new TextDecoder().decode(plain));
      assert(data.check === 'shifttrack-v1', 'INVALID_CREDENTIALS', 'Contraseña incorrecta.');
      privateKey = await crypto.subtle.importKey('jwk', data.key, curve, false, ['sign']);
    } catch {
      const count = attempts.count + 1;
      await db.meta.put({
        id: `attempts:${username}`,
        value: { count, until: count >= 5 ? Date.now() + 60_000 : 0 },
      });
      throw new Error('Usuario o contraseña incorrectos.');
    }
    session = prepared;
    clockAnchor = null;
    try {
      await trustedNow();
      await activateWriter();
    } catch (e) {
      privateKey = null;
      session = null;
      throw e;
    }
    await db.meta.put({ id: `attempts:${username}`, value: { count: 0, until: 0 } });
    return { user: prepared.user, prepared: true, offline: true };
  }
}
export async function trustedNow() {
  assert(
    session && privateKey,
    'NOT_PREPARED',
    'Selecciona tu caja con conexión para preparar este equipo.',
  );
  const wall = Date.now(),
    high = (await db.meta.get('wall-highwater'))?.value || session.lastWall;
  assert(
    wall >= high - 2000,
    'CLOCK_CHANGED',
    'El reloj retrocedió. Necesitas validar con conexión.',
  );
  const now = clockAnchor
    ? clockAnchor.server + performance.now() - clockAnchor.mono
    : wall + session.offset;
  assert(
    now >= Date.parse(session.grant.body.issued_at) &&
      (session.grant.body.expires_at === null || now < Date.parse(session.grant.body.expires_at)),
    'GRANT_EXPIRED',
    'Este acceso anterior venció. Inicia sesión con conexión para actualizarlo; los pendientes se conservan.',
  );
  await db.meta.put({ id: 'wall-highwater', value: Math.max(high, wall) });
  return new Date(now).toISOString();
}
export function expiresAt() {
  return session?.grant.body.expires_at as string | undefined;
}
export async function logout() {
  onlineCredentials = null;
  privateKey = null;
  session = null;
  clockAnchor = null;
  releaseWriter?.();
  releaseWriter = null;
  await logoutSession();
}
export async function snapshot(user: User, branchId: string, refresh = true) {
  const device = await getDevice(branchId),
    key = `snapshot:${branchId}:${user.id}`;
  if (refresh) {
    try {
      const data = await request(`/snapshot?branch_id=${branchId}&device_id=${device.id}`);
      const pending = (await db.outbox.toArray()).filter(
        (x) => x.state !== 'confirmed' && x.command.branch_id === branchId,
      );
      const previous = (await db.caches.get(key))?.value;
      for (const row of pending.filter((x) => x.command.actor_user_id === user.id)) {
        const c = row.command,
          p = c.payload;
        if (c.type === 'task.complete') {
          const task = data.tasks.find((t: any) => t.id === p.id);
          if (task) {
            task.completed_at = c.occurred_at;
            task.note = p.note || '';
          }
        }
        if (c.type === 'cut.create' && !data.cuts.some((x: any) => x.id === p.id)) {
          const local = previous?.cuts.find((x: any) => x.id === p.id);
          if (local) data.cuts.push(local);
        }
        if (c.type === 'shortage.create' && !data.shortages.some((x: any) => x.id === p.id)) {
          const local = previous?.shortages.find((x: any) => x.id === p.id);
          if (local) data.shortages.push(local);
        }
      }
      await db.caches.put({ id: key, value: data });
      if (!pending.some((x) => x.command.type.startsWith('supplier.')))
        await db.caches.put({
          id: `box:${branchId}`,
          value: {
            branch: data.branch,
            suppliers: data.suppliers,
            tickets: data.tickets || [],
            shifts: data.shifts || [],
          },
        });
    } catch (e) {
      if (!(
        e instanceof ApiError &&
        (e.code === 'NETWORK' || (e.code === 'UNAUTHENTICATED' && session?.user.id === user.id))
      ))
        throw e;
    }
  }
  const cached = (await db.caches.get(key))?.value;
  assert(cached, 'NO_CACHE', 'Conecta para descargar los datos de esta sucursal.');
  const box = (await db.caches.get(`box:${branchId}`))?.value;
  // Shared box data is visible only to the designated device's employee or an administrator.
  if (
    box &&
    (user.role !== 'employee' ||
      (session?.grant.body.register_access
        ? session.grant.body.register_number === box.branch.supplier_register
        : box.branch.device_id === device.id))
  )
    return { ...cached, ...box };
  return cached;
}
export async function enqueue(
  type: Command['type'],
  payload: Record<string, string>,
  user: User,
  branchId: string,
  photo?: Blob,
) {
  assert(
    session && privateKey,
    'NOT_PREPARED',
    'Selecciona tu caja con conexión para preparar el acceso antes de registrar movimientos.',
  );
  assert(
    session?.user.id === user.id && session.user.branch_id === branchId,
    'FORBIDDEN',
    'La sesión no corresponde a esta sucursal.',
  );
  assert(
    session.grant.body.allowed_commands.includes(type),
    'FORBIDDEN',
    'Operación no preparada en este equipo.',
  );
  const occurred_at = await trustedNow(),
    device = await getDevice(branchId);
  return navigator.locks.request('shifttrack-write', async () => {
    const box = (await db.caches.get(`box:${branchId}`))?.value;
    assert(box, 'NO_CACHE', 'Conecta para preparar los datos de caja.');
    const b = structuredClone(box.branch),
      supplier = type.startsWith('supplier.'),
      id = crypto.randomUUID();
    if (photo) {
      assert(
        photo.size > 0 && photo.size <= 5 * 1024 * 1024,
        'INVALID_IMAGE',
        'Fotografía de máximo 5 MiB.',
      );
      payload.media_id = crypto.randomUUID();
      payload.media_hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await photo.arrayBuffer())),
      )
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    }
    const pending = (await db.outbox.toArray()).filter(
      (x) =>
        x.state !== 'confirmed' &&
        x.command.branch_id === branchId &&
        x.command.type.startsWith('supplier.'),
    );
    if (supplier)
      assert(
        !pending.some((x) => x.state === 'needs_review' || x.state === 'blocked'),
        'REQUIRES_ADMIN_REVIEW',
        'Resuelve la revisión pendiente antes de operar la caja.',
      );
    const date = localTime(occurred_at, b.timezone).date;
    if (supplier) {
      assert(
        !b.pause_token && !b.local_paused,
        'BOX_PAUSED',
        'Caja detenida para corrección administrativa. Conecta para recibir la nueva versión.',
      );
      assert(
        (session!.grant.body.register_access
          ? session!.grant.body.register_number === b.supplier_register
          : b.device_id === device.id) &&
          b.assignment_epoch === session!.grant.body.assignment_epoch,
        'DEVICE_NOT_ASSIGNED',
        'Este equipo no administra esta caja.',
      );
      assert(
        b.initialized,
        'OPENING_REQUIRED',
        'El administrador debe registrar los saldos de arranque.',
      );
      if (
        b.active_shift &&
        b.active_shift.business_date.slice(0, 10) !== date &&
        type !== 'supplier.shift.reconcile'
      )
        throw new Error('Cuenta el efectivo y reconcilia el turno pendiente del día anterior.');
    }
    let balance = BigInt(b.balance_cents);
    if (type === 'supplier.shift.open') {
      assert(!b.active_shift, 'SHIFT_OPEN', 'Ya hay un responsable en la caja.');
      payload.previous_close_id = b.last_closed_shift || '';
      b.active_shift = {
        id: payload.id,
        actor_user_id: user.id,
        business_date: date,
        opened_at: occurred_at,
        opening_cents: balance.toString(),
      };
    } else if (type === 'supplier.shift.close' || type === 'supplier.shift.reconcile') {
      assert(b.active_shift, 'NO_SHIFT', 'No hay turno abierto.');
      assert(
        type === 'supplier.shift.reconcile' || b.active_shift.actor_user_id === user.id,
        'FORBIDDEN',
        'Solo el responsable cierra su turno.',
      );
      if (type === 'supplier.shift.reconcile')
        assert(
          b.active_shift.business_date.slice(0, 10) < date,
          'FORBIDDEN',
          'Solo reconcilia un turno del día anterior.',
        );
      const amount = cents(payload.counted_cents);
      assert(amount >= 0n, 'INVALID_AMOUNT', 'Conteo inválido.');
      box.shifts = [
        ...box.shifts,
        {
          ...b.active_shift,
          closed_at: occurred_at,
          expected_cents: balance.toString(),
          counted_cents: amount.toString(),
          difference_cents: (amount - balance).toString(),
        },
      ];
      b.last_closed_shift = b.active_shift.id;
      b.active_shift = null;
      balance = amount;
    } else if (
      type === 'supplier.ticket.create' ||
      type === 'supplier.balance.add' ||
      type === 'supplier.ticket.void'
    ) {
      assert(
        b.active_shift?.actor_user_id === user.id,
        'FORBIDDEN',
        'Abre tu turno o recibe el relevo primero.',
      );
      if (type === 'supplier.ticket.void') {
        const ticket = box.tickets.find((x: any) => x.id === payload.id);
        assert(
          ticket &&
            !ticket.voided &&
            ticket.actor_user_id === user.id &&
            ticket.shift_id === b.active_shift.id,
          'FORBIDDEN',
          'No puedes anular este ticket.',
        );
        assert(
          Date.parse(occurred_at) - Date.parse(ticket.occurred_at) <= 300_000,
          'REQUIRES_ADMIN_REVIEW',
          'La anulación propia vence a los cinco minutos.',
        );
        assert(payload.reason?.trim(), 'REASON_REQUIRED', 'Escribe el motivo.');
        ticket.voided = true;
        ticket.void_reason = payload.reason;
        balance += BigInt(ticket.amount_cents);
      } else {
        const amount = cents(payload.amount_cents);
        assert(amount > 0n, 'INVALID_AMOUNT', 'El importe debe ser positivo.');
        balance += type === 'supplier.balance.add' ? amount : -amount;
        if (type === 'supplier.ticket.create')
          box.tickets.push({
            ...payload,
            shift_id: b.active_shift.id,
            actor_user_id: user.id,
            occurred_at,
            voided: false,
          });
      }
    } else if (type === 'supplier.create')
      box.suppliers.push({
        id: payload.id,
        company: payload.company,
        contact: payload.contact,
        active: true,
      });
    const command: Command = {
      operation_id: id,
      schema_version: 1,
      type,
      branch_id: branchId,
      device_id: device.id,
      actor_user_id: user.id,
      grant_id: session!.grant.body.grant_id,
      assignment_epoch: session!.grant.body.assignment_epoch,
      device_seq: supplier ? Number(b.device_seq) + 1 : 0,
      expected_version: b.version,
      occurred_at,
      depends_on: supplier && pending.length ? [pending.at(-1)!.id] : [],
      payload,
    };
    let cutClock: any = null;
    if (type === 'cut.create') {
      const cached = (await db.caches.get(`snapshot:${branchId}:${user.id}`))?.value;
      cutClock = (cached?.clock || [])
        .filter(
          (r: any) => r.user_id === user.id && Date.parse(r.clock_in) <= Date.parse(occurred_at),
        )
        .sort((a: any, b: any) => Date.parse(b.clock_in) - Date.parse(a.clock_in))[0];
      assert(cutClock, 'CLOCK_REQUIRED', 'Registra tu entrada antes de guardar el corte.');
      assert(
        !(cached?.cuts || []).some(
          (r: any) =>
            r.clock_record_id === cutClock.id ||
            (!r.clock_record_id && Date.parse(r.occurred_at) >= Date.parse(cutClock.clock_in)),
        ),
        'DUPLICATE_BUSINESS_RECORD',
        'Este registro de entrada ya tiene un corte.',
      );
      payload.clock_record_id = cutClock.id;
      cutAmounts(payload.sales_cents, payload.card_cents, payload.declared_cents);
    }
    command.signature = await signature(command, privateKey!);
    if (supplier) {
      b.balance_cents = balance.toString();
      b.version = (BigInt(b.version) + 1n).toString();
      b.device_seq = command.device_seq;
      box.branch = b;
    }
    await db.transaction('rw', db.outbox, db.caches, db.media, async () => {
      await db.outbox.add({ id, command, state: 'pending' });
      if (supplier) await db.caches.put({ id: `box:${branchId}`, value: box });
      if (photo) await db.media.add({ id: payload.media_id, blob: photo, confirmed: false });
      const key = `snapshot:${branchId}:${user.id}`,
        cached = (await db.caches.get(key))?.value;
      if (cached) {
        if (type === 'task.complete') {
          const task = cached.tasks.find((t: any) => t.id === payload.id);
          assert(task?.user_id === user.id, 'FORBIDDEN', 'Tarea ajena.');
          task.completed_at = occurred_at;
          task.note = payload.note || '';
          task.media_id = payload.media_id;
        }
        if (type === 'shortage.create')
          cached.shortages.push({ ...payload, actor_user_id: user.id, occurred_at });
        if (type === 'cut.create')
          cached.cuts.push({
            ...payload,
            user_id: user.id,
            business_date: shiftBusinessDate(cutClock.clock_in, b.timezone),
            label: shiftLabel(cutClock.clock_in, b.timezone),
            clock_record_id: cutClock.id,
            ...cutAmounts(payload.sales_cents, payload.card_cents, payload.declared_cents),
            occurred_at,
          });
        await db.caches.put({ id: key, value: cached });
      }
    });
    return id;
  });
}
let syncing = false;
export async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const allRows = (await db.outbox.toArray()).filter(
      (x) => x.state === 'pending' || x.state === 'sending',
    );
    const current = await getDevice();
    const known = (await db.meta.toArray())
      .filter((x) => x.id === 'device' || x.id.startsWith('device:'))
      .map((x) => x.value);
    const devices = Array.from(new Map([current, ...known].map((x) => [x.id, x])).values());
    for (const device of devices) {
      const rows = allRows.filter((x) => x.command.device_id === device.id);
      if (
        !rows.length &&
        !(await db.caches.toArray()).some(
          (x) =>
            x.id.startsWith('box:') &&
            (x.value.branch.device_id === device.id ||
              (device.id === current.id &&
                session?.grant.body.register_access &&
                session.grant.body.register_number === x.value.branch.supplier_register)),
        )
      )
        continue;
      const challenge = await request('/devices/challenge', { device_id: device.id });
      const session = await request('/devices/session', {
        id: challenge.id,
        signature: await signature(challenge, device.private_key),
      });
      // UUIDs are not sortable by creation time; suppliers use their durable stream sequence.
      rows.sort(
        (a, b) =>
          a.command.occurred_at.localeCompare(b.command.occurred_at) ||
          a.command.device_seq - b.command.device_seq,
      );
      for (let i = 0; i < rows.length; i += 20) {
        const batch = rows.slice(i, i + 20);
        await db.outbox.bulkPut(batch.map((x) => ({ ...x, state: 'sending' })));
        for (const row of batch) {
          const id = row.command.payload.media_id;
          if (!id) continue;
          const image = await db.media.get(id);
          if (image && !image.confirmed) {
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve((reader.result as string).split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(image.blob);
            });
            const ack = await request(
              '/media/upload',
              { command: row.command, base64: data },
              `Device ${session.token}`,
            );
            assert(
              ack.media_id === id && ack.status === 'confirmed',
              'UPLOAD_PENDING',
              'La foto aún no está confirmada.',
            );
            await db.media.update(id, { confirmed: true });
          }
        }
        const response = await request(
          '/sync/push',
          { commands: batch.map((x) => x.command) },
          `Device ${session.token}`,
        );
        for (const ack of response.results) {
          const row = await db.outbox.get(ack.operation_id);
          if (!row) continue;
          await db.outbox.update(row.id, {
            state:
              ack.status === 'confirmed'
                ? 'confirmed'
                : ack.code === 'DEPENDENCY_PENDING'
                  ? 'blocked'
                  : 'needs_review',
            message: ack.message,
            result: ack,
          });
        }
      }
      await navigator.locks.request('shifttrack-write', async () => {
        const state = await request('/devices/state', undefined, `Device ${session.token}`),
          key = `box:${state.id}`,
          box = (await db.caches.get(key))?.value;
        if (state.device_id !== device.id && !state.supplier_access) return;
        if (!box) return;
        if (state.pause_token) {
          box.branch.local_paused = true;
          box.branch.pause_token = state.pause_token;
          await db.caches.put({ id: key, value: box });
          const pending = (await db.outbox.toArray()).filter(
            (x) =>
              x.state !== 'confirmed' &&
              x.command.branch_id === state.id &&
              x.command.type.startsWith('supplier.'),
          );
          if (!pending.length)
            await request(
              '/devices/pause-ack',
              {
                pause_token: state.pause_token,
                version: String(box.branch.version),
                device_seq: String(box.branch.device_seq),
              },
              `Device ${session.token}`,
            );
        } else if (box.branch.local_paused) {
          // Keep paused until an authenticated snapshot incorporates the corrected version.
          box.branch.pause_token = null;
          await db.caches.put({ id: key, value: box });
        }
      });
    }
  } finally {
    syncing = false;
  }
}
export async function listPending() {
  return (await db.outbox.toArray()).filter((x) => x.state !== 'confirmed');
}
