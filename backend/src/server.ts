import { assertSafeBinding, loadConfig } from './config/index.js';
import { connect, migrate } from './db/index.js';
import { seedAll } from './db/seed.js';
import { createApp } from './app.js';
import { configureLogger, log } from './utils/logger.js';
import { startSimulator } from './services/simulator.js';

async function main() {
  const cfg = loadConfig();
  configureLogger(cfg.logLevel);
  assertSafeBinding(cfg);

  const db = await connect(cfg);
  const applied = await migrate(db);
  if (applied.length) log('info', 'migrations_applied', { files: applied.join(',') });
  const users = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (users === 0) {
    await seedAll(db, cfg);
    log('info', 'database_seeded');
  }

  if (process.env.LIVE_SIM !== '0') startSimulator(db);
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
