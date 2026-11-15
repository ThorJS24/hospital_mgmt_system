import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');

export type LabMode = 'secure' | 'vulnerable';

export interface AppConfig {
  host: string;
  port: number;
  labMode: LabMode;
  /** Vulnerability IDs enabled when labMode === 'vulnerable'. 'all' enables every scenario. */
  enabledVulns: string[];
  databaseUrl: string | null;
  pgliteDir: string;
  allowContainerBind: boolean;
  sessionTtlMinutes: number;
  labDataDir: string;
  uploadDir: string;
  evidenceDir: string;
  reportDir: string;
  manifestPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  corsOrigin: string;
  /** NODE_ENV=production */
  production: boolean;
  /** Mark the session cookie Secure and use the __Host- prefix (set COOKIE_SECURE=1 whenever the site is served over HTTPS). Default: on in production. */
  cookieSecure: boolean;
  /** Express "trust proxy" setting (e.g. "1" behind one reverse proxy) so req.ip and the protocol come from X-Forwarded-*. null = do not trust. */
  trustProxy: string | null;
  /** Hard upper limit on a session's life regardless of activity. */
  sessionAbsoluteHours: number;
  /** Extra origins allowed to make state-changing requests (the request's own host is always allowed). */
  allowedOrigins: string[];
  /** Serve the built front end (frontend/dist) from this process with a strict CSP. */
  serveFrontend: boolean;
  frontendDir: string;
  rateLimit: { authMax: number; authWindowMs: number; apiMax: number; apiWindowMs: number };
}

const positive = (v: string | undefined, fallback: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const labMode: LabMode = env.LAB_MODE === 'vulnerable' ? 'vulnerable' : 'secure';
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 4000),
    labMode,
    enabledVulns: (env.LAB_VULNS ?? 'all').split(',').map((s) => s.trim()).filter(Boolean),
    databaseUrl: env.DATABASE_URL || null,
    pgliteDir: env.PGLITE_DIR ?? path.join(ROOT, '.pglite'),
    allowContainerBind: env.LAB_ALLOW_CONTAINER_BIND === '1',
    sessionTtlMinutes: Number(env.SESSION_TTL_MINUTES ?? 60),
    labDataDir: path.join(ROOT, 'lab-data'),
    uploadDir: path.join(ROOT, 'lab-data', 'uploads'),
    evidenceDir: path.join(ROOT, 'assessment', 'evidence', 'files'),
    reportDir: path.join(ROOT, 'assessment', 'reports', 'out'),
    manifestPath: path.join(ROOT, 'assessment', 'manifest', 'vulnerabilities.json'),
    logLevel: (env.LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    corsOrigin: env.CORS_ORIGIN ?? 'http://127.0.0.1:5173',
    production: env.NODE_ENV === 'production',
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY || null,
    sessionAbsoluteHours: positive(env.SESSION_ABSOLUTE_HOURS, 12),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    serveFrontend: env.SERVE_FRONTEND === '1',
    frontendDir: path.join(ROOT, 'frontend', 'dist'),
    rateLimit: {
      authMax: positive(env.RATE_LIMIT_AUTH_MAX, 20), authWindowMs: positive(env.RATE_LIMIT_AUTH_WINDOW_MIN, 15) * 60_000,
      apiMax: positive(env.RATE_LIMIT_API_MAX, 600), apiWindowMs: 60_000,
    },
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Lab containment: when vulnerable mode is on the server must be bound to loopback.
 * Inside a container the process binds 0.0.0.0, which is only acceptable when Compose
 * publishes the port on 127.0.0.1 and LAB_ALLOW_CONTAINER_BIND=1 is set explicitly.
 */
export function assertSafeBinding(cfg: AppConfig): void {
  if (cfg.labMode !== 'vulnerable') return;
  if (LOOPBACK.has(cfg.host)) return;
  if (cfg.allowContainerBind) return;
  throw new Error(
    `Refusing to start: LAB_MODE=vulnerable requires HOST to be loopback (got "${cfg.host}"). ` +
      'Set LAB_ALLOW_CONTAINER_BIND=1 only inside the documented Docker Compose lab, ' +
      'where the port is published on 127.0.0.1.',
  );
}

export function isVulnEnabled(cfg: AppConfig, id: string): boolean {
  if (cfg.labMode !== 'vulnerable') return false;
  return cfg.enabledVulns.includes('all') || cfg.enabledVulns.includes(id);
}
