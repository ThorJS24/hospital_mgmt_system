import { loadConfig } from '../config/index.js';
import { connect, migrate } from '../db/index.js';
import { generateAndSave } from '../services/report.js';

/** Local report generation from saved assessment records: `npm run report -- html|json|csv` */
async function main() {
  const fmt = (process.argv[2] ?? 'html') as 'html' | 'json' | 'csv';
  if (!['html', 'json', 'csv'].includes(fmt)) throw new Error('Format must be html, json or csv');
  const cfg = loadConfig();
  const db = await connect(cfg);
  try {
    await migrate(db);
    const g = await generateAndSave(db, cfg, fmt);
    console.log(`Wrote assessment/reports/out/${g.filename} (sha256 ${g.sha256})`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
