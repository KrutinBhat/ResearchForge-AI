import { auth } from './firebase.ts';

let memoryToken: string | null = null;
const SESSION_KEY = 'rf_session_jwt';
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 180_000;

function withRequestTimeout(options: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out.', 'TimeoutError')), timeoutMs);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  return {
    request: { ...options, signal: controller.signal },
    cleanup: () => {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function readApiError(data: any, fallback: string): string {
  const detail = data?.error ?? data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((item) => item?.msg || String(item)).join('; ');
  return fallback;
}

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
  const timed = withRequestTimeout({ ...options, headers });
  try {
    return await fetch(path, timed.request);
  } finally {
    timed.cleanup();
  }
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
      message = readApiError(errData, message);
    } catch {
      // ignore non-json error body
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
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
      xhr.timeout = UPLOAD_TIMEOUT_MS;
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
      xhr.ontimeout = () => reject(new Error('Upload timed out. Please try again with a smaller file or a more stable connection.'));
      xhr.onabort = () => reject(new Error('Upload was cancelled.'));
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
    throw new Error(readApiError(parsed, `Upload failed (${result.status})`));
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
