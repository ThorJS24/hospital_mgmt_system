import { assertSafeBinding, loadConfig } from './config/index.js';
import { connect, migrate } from './db/index.js';
import { randomizedAccounts, seedAll, TEST_ACCOUNTS } from './db/seed.js';
import { verifyPassword } from './utils/crypto.js';
import { createApp } from './app.js';
import { configureLogger, log } from './utils/logger.js';
import { startSimulator } from './services/simulator.js';
import { startMaintenance } from './services/maintenance.js';

async function main() {
  const cfg = loadConfig();
  configureLogger(cfg.logLevel);
  assertSafeBinding(cfg);
  if (cfg.production && cfg.labMode === 'vulnerable') throw new Error('Refusing to start: LAB_MODE=vulnerable must never run with NODE_ENV=production.');
  if (cfg.production && !cfg.cookieSecure) log('warn', 'insecure_cookie_in_production', { hint: 'Serve over HTTPS and keep COOKIE_SECURE on (the default in production).' });

  const db = await connect(cfg);
  const applied = await migrate(db);
  if (applied.length) log('info', 'migrations_applied', { files: applied.join(',') });
  const users = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (users === 0) {
    if (cfg.production) {
      // never create the published development passwords in production: random one-time ones, shown once, must be changed at first sign-in
      const accounts = randomizedAccounts();
      await seedAll(db, cfg, { accounts, mustChangePassword: true });
      console.warn('\n*** FIRST RUN: demo accounts were created with ONE-TIME passwords. Each must be changed at first sign-in. This list is shown once. ***');
      for (const a of accounts) console.warn(`    ${a.username.padEnd(26)} ${a.password}`);
      console.warn('');
    } else {
      await seedAll(db, cfg);
    }
    log('info', 'database_seeded');
  }

  if (cfg.production && process.env.ALLOW_DEFAULT_PASSWORDS !== '1') {
    // an existing database that still has any published development password must not be served in production
    const rows = (await db.query<{ username: string; password_hash: string }>('SELECT username, password_hash FROM users WHERE username = ANY($1::text[])', [TEST_ACCOUNTS.map((a) => a.username)])).rows;
    const weak: string[] = [];
    for (const r of rows) if (await verifyPassword(TEST_ACCOUNTS.find((a) => a.username === r.username)!.password, r.password_hash)) weak.push(r.username);
    if (weak.length) throw new Error(`Refusing to start in production: these accounts still use the published development password: ${weak.join(', ')}. Change them first (or start once with ALLOW_DEFAULT_PASSWORDS=1 to sign in and change them).`);
  }
  if (process.env.LIVE_SIM !== '0') startSimulator(db);
  startMaintenance(db);
  const app = createApp(db, cfg);
  app.listen(cfg.port, cfg.host, () => {
    log('info', 'listening', { host: cfg.host, port: cfg.port, labMode: cfg.labMode, database: db.kind });
    if (cfg.labMode === 'vulnerable') {
      console.warn('\n*** ACADEMIC SECURITY LAB - VULNERABLE MODE ACTIVE - SYNTHETIC DATA ONLY - bound to ' + cfg.host + ' ***\n');
    }
  });
}

main().catch((e) => {
  console.error('Startup failed:', e.message ?? e);
  process.exit(1);
});
