import { auth } from './firebase.ts';

let memoryToken: string | null = null;
const SESSION_KEY = 'rf_session_jwt';

export async function getAuthToken(forceRefresh = false): Promise<string | null> {
  if (auth.currentUser) {
    try {
      const fbToken = await auth.currentUser.getIdToken(forceRefresh);
      memoryToken = fbToken;
      return fbToken;
    } catch {
      // ignore token refresh failure and fall back to memory token
    }
  }
  if (memoryToken && !forceRefresh) return memoryToken;
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

async function performFetch(path: string, options: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...options, headers });
}

export async function apiFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let token = await getAuthToken(false);
  let res = await performFetch(path, options, token);

  // Transparently refresh live Firebase ID token once if expired/rejected with 401
  if (res.status === 401 && auth.currentUser) {
    token = await getAuthToken(true);
    if (token) {
      res = await performFetch(path, options, token);
    }
  }

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

export async function apiUploadWithProgress<T = any>(
  path: string,
  formData: FormData,
  onProgress?: (percent: number) => void
): Promise<T> {
  const sendOnce = async (token: string | null) =>
    new Promise<{ status: number; bodyText: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && onProgress) {
          onProgress(Math.min(99, Math.round((evt.loaded / evt.total) * 100)));
        }
      };
      xhr.onload = () => {
        if (onProgress && xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
        }
        resolve({ status: xhr.status, bodyText: xhr.responseText || '' });
      };
      xhr.onerror = () => reject(new Error('Network error while uploading file.'));
      xhr.send(formData);
    });

  let token = await getAuthToken(false);
  let result = await sendOnce(token);
  if (result.status === 401 && auth.currentUser) {
    token = await getAuthToken(true);
    if (token) {
      result = await sendOnce(token);
    }
  }

  let parsed: any = {};
  try {
    parsed = JSON.parse(result.bodyText || '{}');
  } catch {
    parsed = {};
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(parsed?.error || parsed?.detail || `Upload failed (${result.status})`);
  }
  return parsed as T;
}

export async function apiDownload(path: string, filename: string): Promise<void> {
  let token = await getAuthToken(false);
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let res = await fetch(path, { headers });
  if (res.status === 401 && auth.currentUser) {
    token = await getAuthToken(true);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
      res = await fetch(path, { headers });
    }
  }
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
