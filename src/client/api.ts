// API client. In embedded mode the session token lives in memory only (never localStorage, never the URL after launch).
let bearer: string | null = null;
export const setBearer = (t: string | null) => { bearer = t; };
export class ApiError extends Error { status: number; detail: any; constructor(status: number, message: string, detail?: any) { super(message); this.status = status; this.detail = detail; } }
export let onUnauthorized: () => void = () => {};
export const setOnUnauthorized = (f: () => void) => { onUnauthorized = f; };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'cfo' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized(); throw new ApiError(res.status, data.error ?? 'Request failed.', data.detail); }
  return data as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T = any>(p: string, b: unknown = {}) => api<T>('PUT', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

export async function download(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, 'Export failed.');
  const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}
export function fileToBase64(file: File): Promise<string> {
  return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => bad(r.error); r.readAsDataURL(file); });
}

/** Download a file produced by a POST (the draft email with its attachment). */
export async function postDownload(path: string, body: unknown, filename: string) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cfo', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, credentials: 'same-origin', body: JSON.stringify(body) });
  if (!res.ok) { let m = 'Download failed.'; try { m = (await res.json()).error ?? m; } catch { /* not JSON */ } throw new ApiError(res.status, m); }
  const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}
