// All configuration comes from the environment. Secrets are never committed; see .env.example.
const env = process.env;
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export interface Config {
  port: number; dbPath: string; publicDir: string; production: boolean;
  sessionTtlMinutes: number; embeddedSessionTtlMinutes: number; cookieSecure: boolean;
  portalSsoSecret: string | null; portalIssuer: string; launchTokenMaxAgeSeconds: number;
  embedAllowedOrigins: string[]; maxUploadBytes: number;
  /** Address clients use to reach the dashboard, used for links in emails the firm sends. */ publicUrl: string | null;
  /** PNG logo printed at the top of client packets. Optional: the firm name is printed when the file is missing. */ firmLogoPath: string;
}
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const production = env.NODE_ENV === 'production';
  const cfg: Config = {
    port: Number(env.PORT ?? 4300), dbPath: env.DB_PATH ?? './data/cfo.sqlite', publicDir: env.PUBLIC_DIR ?? './public', production,
    sessionTtlMinutes: Number(env.SESSION_TTL_MINUTES ?? 480), embeddedSessionTtlMinutes: Number(env.EMBEDDED_SESSION_TTL_MINUTES ?? 60),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
    portalSsoSecret: env.PORTAL_SSO_SECRET ?? null, portalIssuer: env.PORTAL_ISSUER ?? 'sjats-client-portal', launchTokenMaxAgeSeconds: 120,
    embedAllowedOrigins: list(env.EMBED_ALLOWED_ORIGINS), maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 15_000_000), publicUrl: env.PUBLIC_URL || null, firmLogoPath: env.FIRM_LOGO_PATH ?? './assets/firm-logo.png',
    ...overrides,
  };
  if (cfg.production && cfg.portalSsoSecret && cfg.portalSsoSecret.length < 32) throw new Error('PORTAL_SSO_SECRET must be at least 32 characters in production.');
  return cfg;
}
