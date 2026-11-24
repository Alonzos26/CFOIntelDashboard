// HTTP application: routing, session resolution, server-side tenant authorization, security headers, static assets.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { type Config } from './config.ts';
import { type Db } from './db.ts';
import { Auth, type Access, type Permission, type Session } from './auth.ts';
import { registerRoutes } from './routes.ts';

export class HttpError extends Error { status: number; extra?: unknown; constructor(status: number, message: string, extra?: unknown) { super(message); this.status = status; this.extra = extra; } }
export const notFound = () => new HttpError(404, 'Not found.');

export interface Ctx {
  req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: any;
  session: Session; tenantId: string; access: Access; db: Db; auth: Auth; cfg: Config;
}
type Handler = (c: Ctx) => unknown;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; perm?: Permission; open?: boolean; staff?: boolean; raw?: boolean }

export class App {
  routes: Route[] = []; db: Db; cfg: Config; auth: Auth;
  constructor(db: Db, cfg: Config) { this.db = db; this.cfg = cfg; this.auth = new Auth(db, cfg); registerRoutes(this); }

  /** Register a route. Paths containing :tid are tenant routes: access is resolved server-side before the handler runs. */
  on(method: string, path: string, handler: Handler, opts: { perm?: Permission; open?: boolean; staff?: boolean; raw?: boolean } = {}) {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, ...opts });
  }

  private token(req: IncomingMessage): { token: string | null; viaCookie: boolean } {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return { token: h.slice(7), viaCookie: false };
    const m = /(?:^|;\s*)cfo_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return { token: m ? decodeURIComponent(m[1]) : null, viaCookie: true };
  }
  sessionCookie(token: string, maxAgeSec: number) {
    return `cfo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${this.cfg.cookieSecure ? '; Secure' : ''}`;
  }
  private securityHeaders(res: ServerResponse) {
    const ancestors = ["'self'", ...this.cfg.embedAllowedOrigins].join(' ');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors ${ancestors}`);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (this.cfg.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  private async readBody(req: IncomingMessage): Promise<any> {
    const limit = Math.ceil(this.cfg.maxUploadBytes * 1.4) + 10_000; const chunks: Buffer[] = []; let size = 0;
    for await (const ch of req) { size += ch.length; if (size > limit) throw new HttpError(413, 'The upload is too large.'); chunks.push(ch as Buffer); }
    if (!size) return {};
    if (!/^application\/json/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Requests must be JSON.');
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    this.securityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://local'); const method = req.method ?? 'GET';
    try {
      if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, res);
      res.setHeader('Cache-Control', 'no-store');
      const route = this.routes.find((r) => r.method === method && r.re.test(url.pathname));
      if (!route) throw notFound();
      const m = route.re.exec(url.pathname)!; const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const { token, viaCookie } = this.token(req);
      // CSRF defence for cookie sessions: state-changing requests must carry a custom header and a same-origin Origin.
      if (method !== 'GET' && (viaCookie || route.open)) {
        const origin = req.headers.origin;
        if (req.headers['x-requested-with'] !== 'cfo' || (origin && new URL(origin).host !== req.headers.host)) throw new HttpError(403, 'Cross-site request refused.');
      }
      const c = { req, res, params, query: url.searchParams, body: method === 'GET' ? {} : await this.readBody(req), db: this.db, auth: this.auth, cfg: this.cfg } as Ctx;
      if (!route.open) {
        const session = this.auth.getSession(token);
        if (!session) throw new HttpError(401, 'Your session has expired. Sign in again.');
        c.session = session;
        if (route.staff && !session.user.staffRole) throw notFound();
        if (params.tid) {
          const access = this.auth.access(session, params.tid);
          if (!access) throw notFound(); // same answer whether the tenant does not exist or is not yours
          if (route.perm && !access.can(route.perm)) throw new HttpError(403, 'Your role does not allow this action.');
          c.access = access; c.tenantId = params.tid;
        }
      }
      const out = await route.handler(c);
      if (route.raw || res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const he = e instanceof HttpError ? e : null;
      if (!he) console.error('[error]', method, url.pathname, e);
      if (!res.headersSent) res.writeHead(he?.status ?? 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: he?.message ?? 'Something went wrong on the server.', ...(he?.extra ? { detail: he.extra } : {}) }));
    }
  }

  private serveStatic(pathname: string, res: ServerResponse) {
    const root = resolve(this.cfg.publicDir);
    let file = normalize(join(root, pathname));
    if (!file.startsWith(root)) { res.writeHead(400); return res.end(); }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // single-page app fallback
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Client bundle not built. Run: npm run build'); }
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.map': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=300' });
    res.end(readFileSync(file));
  }
  listen(port = this.cfg.port) { const server = createServer((req, res) => void this.handle(req, res)); return new Promise<ReturnType<typeof createServer>>((ok) => server.listen(port, () => ok(server))); }
}
