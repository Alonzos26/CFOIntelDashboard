// Authentication, sessions, portal single sign-on (token exchange) and role-based permissions.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { type Db, now, uid } from './db.ts';
import { type Config } from './config.ts';

export type Role = 'super_admin' | 'advisor' | 'analyst' | 'client_owner' | 'client_manager' | 'client_viewer';
export const STAFF_ROLES: Role[] = ['super_admin', 'advisor', 'analyst'];
export const PERMISSIONS = [
  'view', 'view_unapproved', 'view_internal', 'import', 'mapping', 'approve', 'publish', 'settings', 'adjust', 'weekly_entry',
  'scenario_write', 'scenario_approve', 'actions_manage', 'actions_update', 'comment', 'acknowledge', 'kpi_assign', 'kpi_inputs', 'users', 'export', 'daily_cash', 'budget_edit',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Default permission matrix. Change here (or load from configuration) to adjust what each role may do. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: [...PERMISSIONS],
  advisor: [...PERMISSIONS],
  analyst: ['view', 'view_unapproved', 'view_internal', 'import', 'mapping', 'weekly_entry', 'scenario_write', 'comment', 'kpi_inputs', 'export', 'daily_cash', 'budget_edit'],
  // Daily cash is the client's own bank information: the client enters it. Staff may enter it only while the client owner has allowed bank-feed access (checked in the route).
  client_owner: ['view', 'scenario_write', 'actions_update', 'comment', 'acknowledge', 'export', 'daily_cash', 'budget_edit'],
  client_manager: ['view', 'scenario_write', 'comment', 'daily_cash', 'budget_edit'],
  client_viewer: ['view'],
};

export interface User { id: string; email: string; name: string; staffRole: Role | null }
export interface Session { user: User; pinnedTenantId: string | null; tokenHash: string }
export interface Access { role: Role; isStaff: boolean; can: (p: Permission) => boolean; permissions: Permission[] }

export function hashPassword(pw: string): string {
  const salt = randomBytes(16); const key = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64'); const actual = scryptSync(pw, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Auth {
  private failures = new Map<string, { count: number; until: number }>();
  private db: Db; private cfg: Config;
  constructor(db: Db, cfg: Config) { this.db = db; this.cfg = cfg; }

  createSession(userId: string, via: string, pinnedTenantId: string | null): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url');
    const ttl = pinnedTenantId ? this.cfg.embeddedSessionTtlMinutes : this.cfg.sessionTtlMinutes;
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    this.db.run('INSERT INTO sessions (token_hash, user_id, pinned_tenant_id, via, created_at, expires_at) VALUES (?,?,?,?,?,?)', sha(token), userId, pinnedTenantId, via, now(), expiresAt);
    return { token, expiresAt };
  }
  getSession(token: string | null): Session | null {
    if (!token) return null;
    const row = this.db.get('SELECT s.token_hash, s.pinned_tenant_id, s.expires_at, s.revoked_at, u.id, u.email, u.name, u.staff_role, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', sha(token));
    if (!row || row.revoked_at || !row.active || row.expires_at < now()) return null;
    return { user: { id: row.id, email: row.email, name: row.name, staffRole: row.staff_role }, pinnedTenantId: row.pinned_tenant_id, tokenHash: row.token_hash };
  }
  revoke(tokenHash: string) { this.db.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', now(), tokenHash); }
  revokeAllForUser(userId: string) { this.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), userId); }

  login(email: string, password: string): { token: string; expiresAt: string } | { error: string } {
    const key = email.toLowerCase(); const f = this.failures.get(key);
    if (f && f.until > Date.now()) return { error: 'Too many failed attempts. Try again in a few minutes.' };
    const u = this.db.get('SELECT id, password_hash, active FROM users WHERE email = ?', key);
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(key, { count, until: count >= 5 ? Date.now() + 15 * 60_000 : 0 });
      this.db.audit(null, u?.id ?? null, 'auth.login_failed', 'user', key);
      return { error: 'Email or password is incorrect.' };
    }
    this.failures.delete(key);
    this.db.audit(null, u.id, 'auth.login', 'user', u.id);
    return this.createSession(u.id, 'password', null);
  }

  /**
   * Portal single sign-on. The portal BACKEND signs a short-lived, single-use launch token for the signed-in user
   * and the client they are viewing. We verify it, then issue our own session pinned to that one tenant.
   */
  exchangeLaunchToken(jwt: string): { token: string; expiresAt: string; tenantId: string } | { error: string } {
    if (!this.cfg.portalSsoSecret) return { error: 'Portal sign-on is not configured.' };
    const parts = jwt.split('.');
    if (parts.length !== 3) return { error: 'Malformed launch token.' };
    let header: any, c: any;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); c = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return { error: 'Malformed launch token.' }; }
    if (header.alg !== 'HS256') return { error: 'Unsupported token algorithm.' };
    const expected = createHmac('sha256', this.cfg.portalSsoSecret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: 'Launch token signature is invalid.' };
    const nowS = Math.floor(Date.now() / 1000);
    if (c.iss !== this.cfg.portalIssuer || c.aud !== 'sjats-cfo') return { error: 'Launch token was not issued for this application.' };
    if (typeof c.exp !== 'number' || c.exp < nowS) return { error: 'Launch token has expired.' };
    if (typeof c.iat !== 'number' || c.exp - c.iat > this.cfg.launchTokenMaxAgeSeconds || c.iat > nowS + 30) return { error: 'Launch token lifetime is not acceptable.' };
    if (typeof c.jti !== 'string' || typeof c.sub !== 'string' || typeof c.client !== 'string') return { error: 'Launch token is missing required claims.' };
    this.db.run('DELETE FROM launch_tokens_used WHERE expires_at < ?', now());
    try { this.db.run('INSERT INTO launch_tokens_used (jti, expires_at) VALUES (?,?)', c.jti, new Date(c.exp * 1000).toISOString()); } catch { return { error: 'Launch token has already been used.' }; }
    const tenant = this.db.get('SELECT id FROM tenants WHERE portal_client_id = ? AND status = ?', c.client, 'active');
    const user = this.db.get('SELECT id, staff_role, active FROM users WHERE email = ?', String(c.sub).toLowerCase());
    // The token says who the portal authenticated; OUR records decide what that person may see.
    if (!tenant || !user || !user.active) return { error: 'No CFO dashboard access is set up for this account.' };
    const member = this.db.get('SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?', user.id, tenant.id);
    if (!member && user.staff_role !== 'super_admin') return { error: 'No CFO dashboard access is set up for this account.' };
    this.db.audit(tenant.id, user.id, 'auth.portal_exchange', 'tenant', tenant.id);
    return { ...this.createSession(user.id, 'portal', tenant.id), tenantId: tenant.id };
  }

  /** Server-side tenant authorization. Returns null when the user has no access — callers answer 404, never 403, to avoid confirming a tenant exists. */
  access(session: Session, tenantId: string): Access | null {
    if (session.pinnedTenantId && session.pinnedTenantId !== tenantId) return null;
    const t = this.db.get('SELECT id FROM tenants WHERE id = ? AND status = ?', tenantId, 'active');
    if (!t) return null;
    let role: Role | null = null;
    if (session.user.staffRole === 'super_admin') role = 'super_admin';
    else {
      const m = this.db.get('SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?', session.user.id, tenantId);
      if (m) role = m.role as Role;
    }
    if (!role) return null;
    const permissions = ROLE_PERMISSIONS[role];
    return { role, isStaff: STAFF_ROLES.includes(role), permissions, can: (p) => permissions.includes(p) };
  }
  tenantsFor(session: Session): { id: string; name: string; role: Role; isSynthetic: boolean }[] {
    const rows = session.user.staffRole === 'super_admin'
      ? this.db.all("SELECT id, name, is_synthetic, 'super_admin' AS role FROM tenants WHERE status = 'active' ORDER BY name")
      : this.db.all("SELECT t.id, t.name, t.is_synthetic, m.role FROM tenants t JOIN memberships m ON m.tenant_id = t.id WHERE m.user_id = ? AND t.status = 'active' ORDER BY t.name", session.user.id);
    return rows.filter((r) => !session.pinnedTenantId || r.id === session.pinnedTenantId).map((r) => ({ id: r.id, name: r.name, role: r.role, isSynthetic: !!r.is_synthetic }));
  }
}

/** Helper for the portal side (and tests): mint a launch token. In production this runs in the portal backend only. */
export function mintLaunchToken(secret: string, claims: { sub: string; client: string; iss?: string; ttlSeconds?: number }): string {
  const iat = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: claims.iss ?? 'sjats-client-portal', aud: 'sjats-cfo', sub: claims.sub, client: claims.client, iat, exp: iat + (claims.ttlSeconds ?? 60), jti: uid() })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
