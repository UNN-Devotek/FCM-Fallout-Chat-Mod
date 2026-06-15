const BASE = '';

interface ApiError extends Error {
  status?: number;
  data?: any;
}

interface FetchOptions {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
}

async function apiFetch<T = any>(path: string, options: FetchOptions = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const headers: Record<string, string> = isFormData
    ? { ...options.headers }
    : { 'Content-Type': 'application/json', ...options.headers };
  const body = options.body
    ? (isFormData ? options.body : JSON.stringify(options.body))
    : undefined;

  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers,
    ...options,
    body,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const error: ApiError = new Error(err.detail || `HTTP ${res.status}`);
    error.status = res.status;
    error.data = err;
    // Ban lockdown: backend serialises ban details as JSON in the `detail`
    // string. Parse + raise a global event so AppRoot can render a full-page
    // 'banned' splash regardless of which call tripped the check.
    if (res.status === 403 && typeof err.detail === 'string' && err.detail.startsWith('{')) {
      try {
        const parsed = JSON.parse(err.detail);
        if (parsed.type === 'banned') {
          window.dispatchEvent(new CustomEvent('fcm:banned', { detail: parsed }));
        }
      } catch { /* not a structured 403; fall through */ }
    }
    throw error;
  }

  if (res.status === 204) return null as T;
  const data = await res.json();
  return data.data;
}

export const api = {
  get: <T = any>(path: string) => apiFetch<T>(path),
  post: <T = any>(path: string, body?: any) => apiFetch<T>(path, { method: 'POST', body }),
  put: <T = any>(path: string, body?: any) => apiFetch<T>(path, { method: 'PUT', body }),
  patch: <T = any>(path: string, body?: any) => apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T = any>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};
