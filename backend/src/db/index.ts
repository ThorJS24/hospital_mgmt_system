import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { AppConfig } from '../config/index.js';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Execute one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

// Normalise column types so both drivers return identical JSON shapes.
const identity = (v: string) => v;
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1082, identity);
const pgliteParsers = { 1700: (v: string) => parseFloat(v), 20: (v: string) => parseInt(v, 10), 1082: identity };

function wrapPg(pool: pg.Pool): Db {
  const make = (c: pg.Pool | pg.PoolClient) => ({
    query: (sql: string, params?: unknown[]) => c.query(sql, params as any[]) as Promise<{ rows: any[] }>,
    exec: async (sql: string) => {
      await c.query(sql);
    },
  });
  const self: Db = {
    kind: 'postgres',
    ...make(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inner: Db = { kind: 'postgres', ...make(client), tx: (f) => f(inner), close: async () => {} };
        const r = await fn(inner);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return self;
}

function wrapPglite(db: PGlite): Db {
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params as any[]) as Promise<{ rows: any[] }>,
    exec: async (sql) => {
      await db.exec(sql);
    },
    tx(fn) {
      return db.transaction(async (t) => {
        const inner: Db = {
          kind: 'pglite',
          query: (sql, params) => t.query(sql, params as any[]) as Promise<{ rows: any[] }>,
          exec: async (sql) => {
            await t.exec(sql);
          },
          tx: (f) => f(inner),
          close: async () => {},
        };
        return fn(inner);
      });
    },
    close: () => db.close(),
  };
}

/** Postgres when DATABASE_URL is set, otherwise embedded PGlite (in-memory when `memory`). */
export async function connect(cfg: Pick<AppConfig, 'databaseUrl' | 'pgliteDir'>, memory = false): Promise<Db> {
  if (cfg.databaseUrl && !memory) return wrapPg(new pg.Pool({ connectionString: cfg.databaseUrl }));
  const dir = memory ? undefined : cfg.pgliteDir;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return wrapPglite(new PGlite(dir, { parsers: pgliteParsers as any }));
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
    applied.push(file);
  }
  return applied;
}
