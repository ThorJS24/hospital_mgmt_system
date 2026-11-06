import type { Db } from '../db/index.js';
import { scanInventory, scanOverdueInvoices } from './notifications.js';
import { sendDueReminders } from './reminders.js';
import { log } from '../utils/logger.js';

export interface MaintenanceResult { overdueInvoices: number; inventoryAlerts: number; remindersQueued: number; expiredSessions: number }

/** Periodic housekeeping: alert scans, appointment reminders and expired session / challenge clean-up. Idempotent. */
export async function runMaintenance(db: Db): Promise<MaintenanceResult> {
  const expiredSessions = (await db.query('DELETE FROM sessions WHERE expires_at < now() - interval \'1 day\' RETURNING id')).rows.length;
  await db.query('DELETE FROM login_challenges WHERE expires_at < now()');
  return {
    overdueInvoices: await scanOverdueInvoices(db),
    inventoryAlerts: await scanInventory(db),
    remindersQueued: await sendDueReminders(db),
    expiredSessions,
  };
}

/** Runs once shortly after start and then every 15 minutes. The timer never keeps the process alive. */
export function startMaintenance(db: Db, intervalMs = 15 * 60_000): () => void {
  const run = () => runMaintenance(db).catch((e) => log('warn', 'maintenance_error', { message: String(e?.message ?? e) }));
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
