export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: { field: string; message: string }[], public requestId?: string) {
    super(message);
  }
}

let csrfToken = '';
export const setCsrf = (t: string) => { csrfToken = t; };

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is the backend running?');
  }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data?.details, data?.requestId);
  return data as T;
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const patch = <T = any>(url: string, body?: unknown) => api<T>('PATCH', url, body ?? {});
export const put = <T = any>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const money = (n: number | null | undefined) => (n == null ? '-' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n));
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-');
export const fmtDateTime = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
export const toBase64 = (buf: ArrayBuffer) => {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
