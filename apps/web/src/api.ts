// Token opaco por pestaña; la expiración y revocación se verifican en PostgreSQL.
const sessionKey = 'shifttrack-session-v1';
let accessToken: string | undefined;
try {
  accessToken = sessionStorage.getItem(sessionKey) || undefined;
} catch {
  /* memoria si no hay storage */
}
function storeToken(token?: string) {
  accessToken = token;
  try {
    if (token) sessionStorage.setItem(sessionKey, token);
    else sessionStorage.removeItem(sessionKey);
  } catch {
    /* No guardar contraseñas ni recurrir a localStorage. */
  }
}
export function hasOnlineSession() {
  return !!accessToken;
}
// pagehide covers tab/window close and navigation without logging out on minimization.
// Delivery is best effort; a fresh login can recover its own box on this device.
function closeWindowSession() {
  const token = accessToken;
  storeToken();
  if (!token) return;
  const body = JSON.stringify({ token });
  if (
    !navigator.sendBeacon?.(
      '/api/v1/auth/logout-on-close',
      new Blob([body], { type: 'application/json' }),
    )
  )
    fetch('/api/v1/auth/logout-on-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
}
window.addEventListener('pagehide', closeWindowSession);
window.addEventListener('beforeunload', closeWindowSession);
// A page restored from the back/forward cache must not reuse its revoked session.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function request(path: string, body?: unknown, authorization?: string) {
  const token = authorization ?? (accessToken ? `Bearer ${accessToken}` : undefined);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError('NETWORK', 'No se pudo conectar con el servidor.');
  }
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.code, result.message);
  return result;
}
export async function onlineLogin(username: string, password: string) {
  const result = await request('/auth/login', { username, password });
  storeToken(result.access_token);
  return result;
}
export async function logoutSession() {
  const token = accessToken;
  storeToken();
  if (token && navigator.onLine) {
    try {
      await request('/auth/logout', {}, `Bearer ${token}`);
    } catch {
      /* Sin red: se borra el acceso local; la caja puede recuperarse al volver a entrar en este equipo. */
    }
  }
}
export async function download(path: string, filename: string) {
  if (!accessToken) throw new Error('Inicia sesión con conexión.');
  const response = await fetch(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error('No se pudo descargar el archivo.');
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function imageUrl(id: string, branchId: string) {
  if (!accessToken) throw new Error('Conecta para ver la evidencia sincronizada.');
  const r = await fetch(`/api/v1/media/${id}/content?branch_id=${branchId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error('No se pudo cargar la evidencia.');
  return URL.createObjectURL(await r.blob());
}
