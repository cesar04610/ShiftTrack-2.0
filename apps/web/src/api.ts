import { initializeApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  signInWithCustomToken,
  signOut,
  browserSessionPersistence,
  setPersistence,
} from 'firebase/auth';
const firebase = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ??
    `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
});
export const auth = getAuth(firebase);
if (import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL)
  connectAuthEmulator(auth, import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL, {
    disableWarnings: true,
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
  const token =
    authorization ??
    (auth.currentUser ? `Bearer ${await auth.currentUser.getIdToken()}` : undefined);
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
  await setPersistence(auth, browserSessionPersistence);
  await signInWithCustomToken(auth, result.custom_token);
  return result;
}
export async function logoutFirebase() {
  await signOut(auth);
}
export async function download(path: string, filename: string) {
  if (!auth.currentUser) throw new Error('Inicia sesión con conexión.');
  const response = await fetch(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` },
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
  if (!auth.currentUser) throw new Error('Conecta para ver la evidencia sincronizada.');
  const r = await fetch(`/api/v1/media/${id}/content?branch_id=${branchId}`, {
    headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` },
  });
  if (!r.ok) throw new Error('No se pudo cargar la evidencia.');
  return URL.createObjectURL(await r.blob());
}
