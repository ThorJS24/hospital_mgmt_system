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
}

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
