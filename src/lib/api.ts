import { auth } from './firebase.ts';

let memoryToken: string | null = null;
const SESSION_KEY = 'rf_session_jwt';

export async function getAuthToken(): Promise<string | null> {
  if (auth.currentUser) {
    try {
      const fbToken = await auth.currentUser.getIdToken();
      memoryToken = fbToken;
      return fbToken;
    } catch {
      // ignore token refresh failure and fall back to memory token
    }
  }
  if (memoryToken) return memoryToken;
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null, isFirebase = false) {
  memoryToken = token;
  try {
    if (!token || isFirebase) {
      // Never persist Firebase ID tokens in web storage
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, token);
    }
  } catch {
    // ignore sessionStorage unavailability
  }
}

export async function apiFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const errData = await res.json();
      if (errData?.error) message = errData.error;
      else if (errData?.detail) message = errData.detail;
    } catch {
      // ignore non-json error body
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function apiDownload(path: string, filename: string): Promise<void> {
  const token = await getAuthToken();
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { headers });
  if (!res.ok) {
    throw new Error(`Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
