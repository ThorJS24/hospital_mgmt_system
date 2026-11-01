import type { Db } from '../db/index.js';
import { emitLive } from './live.js';
import { log } from '../utils/logger.js';

/**
 * Background activity simulator: makes the synthetic hospital "breathe" so dashboards, queues and
 * the live feed change in real time. Operates only on the local synthetic dataset; disable with LIVE_SIM=0.
 */
const pad = (n: number) => String(n).padStart(2, '0');
const naiveNow = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const rnd = (n: number) => Math.floor(Math.random() * n);
const FIRST = ['Amelia', 'Rohan', 'Chen', 'Lucia', 'Tariq', 'Elena', 'Marcus', 'Nia', 'Viktor', 'Sana'];
const LAST = ['Whitfield', 'Mehra', 'Larsen', 'Duran', 'Okoye', 'Petrov', 'Ishikawa', 'Brooks', 'Sandoval', 'Haas'];

async function simAudit(db: Db, action: string, entity: string, id: string | number, detail = '') {
  await db.query("INSERT INTO audit_events(user_id,action,entity,entity_id,detail,request_id) VALUES (NULL,$1,$2,$3,$4,'live-sim')", [action, entity, String(id), detail]);
}

const actions: (() => Promise<void>)[] = [];
export function startSimulator(db: Db, intervalMs = 7000): () => void {
  actions.length = 0;

  // appointment progresses through the clinic flow
  actions.push(async () => {
    const a = (await db.query<{ id: number; status: string; dept: string }>(`SELECT a.id, a.status, d.name AS dept FROM appointments a JOIN departments d ON d.id=a.department_id
        WHERE a.scheduled_at::date = current_date AND a.status IN ('Scheduled','Confirmed','Checked in','In consultation') AND a.scheduled_at <= now() + interval '45 minutes' ORDER BY random() LIMIT 1`)).rows[0];
    if (!a) return;
    const next = { Scheduled: 'Checked in', Confirmed: 'Checked in', 'Checked in': 'In consultation', 'In consultation': 'Completed' }[a.status]!;
    await db.query('UPDATE appointments SET status=$1 WHERE id=$2', [next, a.id]);
    await simAudit(db, 'appointment_status', 'appointment', a.id, next);
    emitLive('appointment', next === 'Checked in' ? `Patient checked in — ${a.dept}` : next === 'In consultation' ? `Consultation started — ${a.dept}` : `Consultation completed — ${a.dept}`);
  });

  // laboratory pipeline
  actions.push(async () => {
    const l = (await db.query<{ id: number; status: string; test_id: number; test: string; unit: string }>(`SELECT lr.id, lr.status, lr.test_id, t.name AS test, t.unit FROM laboratory_requests lr JOIN laboratory_tests t ON t.id=lr.test_id
        WHERE lr.status IN ('Requested','In progress','Resulted') ORDER BY random() LIMIT 1`)).rows[0];
    if (!l) return;
    if (l.status === 'Requested') {
      const tech = (await db.query<{ id: number }>("SELECT id FROM staff WHERE staff_code LIKE 'LAB-%' ORDER BY random() LIMIT 1")).rows[0];
      await db.query("UPDATE laboratory_requests SET status='In progress', assigned_tech_id=$1 WHERE id=$2", [tech.id, l.id]);
      emitLive('lab', `Sample received — ${l.test}`);
    } else if (l.status === 'In progress') {
      const value = (1 + Math.random() * 12).toFixed(1);
      await db.query('INSERT INTO laboratory_results(request_id,value,comment,entered_at) VALUES ($1,$2,$3,$4) ON CONFLICT (request_id) DO NOTHING', [l.id, value, 'SYNTHETIC RESULT - not for clinical use', naiveNow()]);
      await db.query("UPDATE laboratory_requests SET status='Resulted' WHERE id=$1", [l.id]);
      emitLive('lab', `Result entered — ${l.test}`);
    } else {
      await db.query('UPDATE laboratory_results SET approved=true WHERE request_id=$1', [l.id]);
      await db.query("UPDATE laboratory_requests SET status='Approved' WHERE id=$1", [l.id]);
      emitLive('lab', `Result approved — ${l.test}`);
    }
    await simAudit(db, 'lab_progress', 'laboratory_request', l.id);
  });

  // new laboratory order
  actions.push(async () => {
    const r = (await db.query<{ id: number; test: string }>(`INSERT INTO laboratory_requests(patient_id,test_id,ordering_doctor_id,requested_at)
        SELECT (SELECT id FROM patients ORDER BY random() LIMIT 1), t.id, (SELECT id FROM staff WHERE staff_code LIKE 'DOC-%' ORDER BY random() LIMIT 1), $1::timestamp FROM laboratory_tests t ORDER BY random() LIMIT 1
        RETURNING id, (SELECT name FROM laboratory_tests WHERE id=test_id) AS test`, [naiveNow()])).rows[0];
    await simAudit(db, 'lab_request', 'laboratory_request', r.id);
    emitLive('lab', `New laboratory order — ${r.test}`);
  });

  // payment received
  actions.push(async () => {
    const i = (await db.query<{ id: number; invoice_no: string; balance: number; total: number }>(`SELECT i.id, i.invoice_no,
        (COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0) - COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0))::float AS balance,
        COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0)::float AS total
        FROM invoices i WHERE i.status IN ('Issued','Partially paid') ORDER BY random() LIMIT 1`)).rows[0];
    if (!i || i.balance <= 0) return;
    const full = Math.random() < 0.5;
    const amount = full ? i.balance : Math.max(1, Math.round(i.balance * (0.3 + Math.random() * 0.4) * 100) / 100);
    await db.query('INSERT INTO payments(invoice_id,amount,method,paid_at) VALUES ($1,$2,$3,$4)', [i.id, amount, 'Card (synthetic)', naiveNow()]);
    await db.query('UPDATE invoices SET status=$1 WHERE id=$2', [amount >= i.balance - 0.005 ? 'Paid' : 'Partially paid', i.id]);
    await simAudit(db, 'payment_record', 'invoice', i.id, `amount=${amount}`);
    emitLive('billing', `Payment received — ${i.invoice_no}`);
  });

  // new registration (rare)
  actions.push(async () => {
    if (Math.random() > 0.35) return;
    const n = (await db.query<{ n: number }>("SELECT COALESCE(max(substring(mrn from 5)::int),0)+1 AS n FROM patients WHERE mrn ~ '^SYN-[0-9]+$'")).rows[0].n;
    const f = FIRST[rnd(FIRST.length)], l = LAST[rnd(LAST.length)];
    const dob = new Date(Date.now() - (6000 + Math.random() * 25000) * 86400000).toISOString().slice(0, 10);
    const doc = (await db.query<{ id: number }>("SELECT id FROM staff WHERE staff_code LIKE 'DOC-%' ORDER BY random() LIMIT 1")).rows[0];
    const { rows } = await db.query<{ id: number }>('INSERT INTO patients(mrn,first_name,last_name,dob,sex,phone,email,address,primary_doctor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [`SYN-${String(n).padStart(6, '0')}`, f, l, dob, ['Amelia', 'Lucia', 'Elena', 'Nia', 'Sana'].includes(f) ? 'Female' : 'Male', `555-01${pad(n % 100)}`, `${f}.${l}${n}@patients.example.test`.toLowerCase(), `${100 + rnd(880)} Maple Avenue, Riverton, OH 44101`, doc.id]);
    await simAudit(db, 'patient_register', 'patient', rows[0].id);
    emitLive('patient', 'New patient registered at front desk');
  });

  // admission flow (rare)
  actions.push(async () => {
    if (Math.random() > 0.3) return;
    const active = (await db.query<{ id: number; ward: string }>("SELECT a.id, w.name AS ward FROM admissions a JOIN beds b ON b.id=a.bed_id JOIN wards w ON w.id=b.ward_id WHERE a.status='Admitted' ORDER BY random() LIMIT 1")).rows[0];
    const free = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM beds WHERE id NOT IN (SELECT bed_id FROM admissions WHERE status='Admitted')")).rows[0].n;
    if (active && (free < 6 || Math.random() < 0.5)) {
      await db.query("UPDATE admissions SET status='Discharged', discharged_at=$1 WHERE id=$2", [naiveNow(), active.id]);
      await simAudit(db, 'admission_discharge', 'admission', active.id);
      emitLive('admission', `Patient discharged — ${active.ward}`);
    } else {
      const adm = (await db.query<{ id: number; ward: string }>(`INSERT INTO admissions(patient_id,bed_id,doctor_id,admitted_at,reason)
        SELECT p.id, b.id, (SELECT id FROM staff WHERE staff_code LIKE 'DOC-%' ORDER BY random() LIMIT 1), $1::timestamp, 'Observation'
          FROM (SELECT id FROM patients WHERE id NOT IN (SELECT patient_id FROM admissions WHERE status='Admitted') ORDER BY random() LIMIT 1) p,
               (SELECT id FROM beds WHERE id NOT IN (SELECT bed_id FROM admissions WHERE status='Admitted') ORDER BY random() LIMIT 1) b
        RETURNING id, (SELECT w.name FROM beds bb JOIN wards w ON w.id=bb.ward_id WHERE bb.id=bed_id) AS ward`, [naiveNow()])).rows[0];
      if (adm) { await simAudit(db, 'admission_create', 'admission', adm.id); emitLive('admission', `Patient admitted — ${adm.ward}`); }
    }
  });

  const timer = setInterval(() => {
    const act = actions[rnd(actions.length)];
    act().catch((e) => log('warn', 'simulator_error', { message: String(e?.message ?? e) }));
  }, intervalMs);
  timer.unref();
  log('info', 'live_simulator_started', { intervalMs });
  return () => clearInterval(timer);
}
