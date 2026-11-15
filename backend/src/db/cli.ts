import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config/index.js';
import { connect, migrate } from './index.js';
import { seedAll, seedAssessment, seedClinical } from './seed.js';
import { restoreDemoPasswords } from './passwords.js';

/**
 * Local-only database tooling (never exposed over HTTP).
 *   migrate | seed | reset [--yes] [--include-assessment] | reset-passwords [username ...]
 * reset-passwords restores the documented demo passwords (all demo accounts, or only those named) and keeps all other data.
 * Reset policy: clinical data is rebuilt deterministically; assessment records and
 * evidence are PRESERVED unless --include-assessment is passed.
 */
function assertLocal(databaseUrl: string | null) {
  const target = databaseUrl ? new URL(databaseUrl) : null;
  if (target && !['localhost', '127.0.0.1', '::1', 'db'].includes(target.hostname)) {
    throw new Error(`Refusing to run against non-local database host "${target.hostname}".`);
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run when NODE_ENV=production.');
}

async function main() {
  const cmd = process.argv[2];
  const flags = new Set(process.argv.slice(3));
  const cfg = loadConfig();
  const db = await connect(cfg);
  try {
    if (cmd === 'migrate') {
      const applied = await migrate(db);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema up to date.');
    } else if (cmd === 'seed') {
      await migrate(db);
      await seedAll(db, cfg);
      console.log('Synthetic dataset seeded.');
    } else if (cmd === 'reset-passwords') {
      assertLocal(cfg.databaseUrl);
      const names = [...flags].filter((f) => !f.startsWith('--'));
      await migrate(db);
      const r = await restoreDemoPasswords(db, names);
      if (r.restored.length) console.log(`Restored the demo password for: ${r.restored.join(', ')}`);
      if (r.missing.length) console.log(`No such user in this database (try "npm run db:seed" on an empty database): ${r.missing.join(', ')}`);
      if (r.unknown.length) console.log(`Not a demo account, left untouched: ${r.unknown.join(', ')}`);
      if (!r.restored.length) process.exitCode = 1;
    } else if (cmd === 'reset') {
      assertLocal(cfg.databaseUrl);
      if (!flags.has('--yes')) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const a = await rl.question('This DELETES all synthetic clinical data and rebuilds it. Type "reset" to continue: ');
        rl.close();
        if (a.trim() !== 'reset') throw new Error('Aborted.');
      }
      await migrate(db);
      if (flags.has('--include-assessment')) {
        await db.exec('TRUNCATE assessment_results, assessment_evidence, assessment_finding_history, remediation_records, assessment_test_cases, assessment_findings, assessment_projects RESTART IDENTITY CASCADE');
      }
      await seedClinical(db);
      await seedAssessment(db, cfg);
      console.log(`Reset complete (assessment records ${flags.has('--include-assessment') ? 'rebuilt' : 'preserved'}).`);
    } else {
      console.log('Usage: cli.ts <migrate|seed|reset [--yes] [--include-assessment]|reset-passwords [username ...]>');
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
