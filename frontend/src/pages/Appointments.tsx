import { useMemo, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { get, post, patch, fmtDateTime, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, DataTable, EmptyState, Modal, PageHeader, SelectField, StatusBadge, Tabs, TextField, Toolbar, errMsg, fieldErrors, useAsync, useList, useToast, type Column } from '../components/ui';

const STATUSES = ['Scheduled', 'Confirmed', 'Checked in', 'In consultation', 'Completed', 'Cancelled', 'No-show'];
const NEXT: Record<string, string[]> = {
  Scheduled: ['Confirmed', 'Checked in', 'Cancelled', 'No-show'], Confirmed: ['Checked in', 'Cancelled', 'No-show'],
  'Checked in': ['In consultation', 'Cancelled'], 'In consultation': ['Completed'], Completed: [], Cancelled: [], 'No-show': [],
};
interface Row { id: number; scheduled_at: string; duration_min: number; status: string; reason: string; patient: string; mrn: string; doctor: string; department: string; patient_id: number; doctor_id: number }

export default function Appointments() {
  const { can } = useAuth(); const toast = useToast();
  const list = useList<Row>('/api/appointments', 'time', 15);
  const [view, setView] = useState('list');
  const [create, setCreate] = useState(false);
  const [resched, setResched] = useState<Row | null>(null);
  const depts = useAsync(() => get('/api/departments'), []);
  const docs = useAsync(() => get('/api/staff?kind=doctor&pageSize=50'), []);
  const canWrite = can('appointments.write');

  const setStatus = async (r: Row, status: string) => {
    try { await post(`/api/appointments/${r.id}/status`, { status }); toast(`Appointment marked ${status}`); list.reload(); } catch (x) { toast(errMsg(x), 'danger'); }
  };
  const cols: Column<Row>[] = [
    { key: 'time', label: 'When', sortKey: 'time', render: (r) => fmtDateTime(r.scheduled_at), className: 'whitespace-nowrap' },
    { key: 'patient', label: 'Patient', sortKey: 'patient', render: (r) => <>{r.patient} <span className="text-muted">({r.mrn})</span></> },
    { key: 'doctor', label: 'Doctor', sortKey: 'doctor' },
    { key: 'department', label: 'Department', sortKey: 'department' },
    { key: 'reason', label: 'Reason' },
    { key: 'status', label: 'Status', sortKey: 'status', render: (r) => <StatusBadge status={r.status} /> },
  ];
  return (
    <div>
      <PageHeader title="Appointments" actions={canWrite ? <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New appointment</Button> : undefined} />
      <Tabs tabs={[{ id: 'list', label: 'List' }, { id: 'schedule', label: 'Weekly schedule' }]} value={view} onChange={setView} />
      <div className="mt-4 card-shadow rounded-xl border border-line bg-surface p-4">
        <Toolbar list={list} placeholder="Patient or doctor">
          <TextField label="Date" type="date" value={list.state.filters.date ?? ''} onChange={(e) => list.setFilter('date', e.target.value)} />
          <SelectField label="Department" value={list.state.filters.department_id ?? ''} onChange={(e) => list.setFilter('department_id', e.target.value)}><option value="">All</option>{(depts.data?.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</SelectField>
          <SelectField label="Doctor" value={list.state.filters.doctor_id ?? ''} onChange={(e) => list.setFilter('doctor_id', e.target.value)}><option value="">All</option>{(docs.data?.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</SelectField>
          <SelectField label="Status" value={list.state.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}><option value="">All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</SelectField>
        </Toolbar>
        {view === 'list' ? (
          <DataTable list={list} columns={cols} caption="Appointments" empty="No appointments match"
            actions={canWrite ? (r) => (
              <div className="flex flex-wrap justify-end gap-1">
                {['Scheduled', 'Confirmed'].includes(r.status) && <Button variant="ghost" onClick={() => setResched(r)}>Reschedule</Button>}
                {NEXT[r.status].length > 0 && <select aria-label={`Change status for appointment ${r.id}`} className="rounded-md border border-line bg-surface px-2 py-1 text-xs" value="" onChange={(e) => e.target.value && void setStatus(r, e.target.value)}><option value="">Change status…</option>{NEXT[r.status].map((s) => <option key={s}>{s}</option>)}</select>}
              </div>) : undefined} />
        ) : <Schedule filters={list.state.filters} />}
      </div>
      <CreateDialog open={create} onClose={() => setCreate(false)} docs={docs.data?.data ?? []} onDone={() => { setCreate(false); list.reload(); toast('Appointment created'); }} />
      <RescheduleDialog row={resched} onClose={() => setResched(null)} onDone={() => { setResched(null); list.reload(); toast('Appointment rescheduled'); }} />
    </div>
  );
}

function Schedule({ filters }: { filters: Record<string, string> }) {
  const start = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0, 0, 0, 0); return d; }, []);
  const [offset, setOffset] = useState(0);
  const from = new Date(start.getTime() + offset * 7 * 86400000);
  const to = new Date(from.getTime() + 6 * 86400000);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const { data, loading, error } = useAsync(() => get(`/api/appointments${qs({ from: iso(from), to: iso(to), pageSize: 100, sort: 'time', department_id: filters.department_id, doctor_id: filters.doctor_id, status: filters.status })}`), [offset, filters.department_id, filters.doctor_id, filters.status]);
  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * 86400000));
  return (
    <div>
      <div className="mb-3 flex items-center justify-between"><Button variant="secondary" onClick={() => setOffset(offset - 1)}>Previous week</Button><strong>{from.toLocaleDateString()} – {to.toLocaleDateString()}</strong><Button variant="secondary" onClick={() => setOffset(offset + 1)}>Next week</Button></div>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-2 md:grid-cols-7" aria-busy={loading}>
        {days.map((d) => {
          const items = (data?.data ?? []).filter((a: Row) => a.scheduled_at.slice(0, 10) === iso(d));
          return (
            <section key={d.toISOString()} className="min-h-24 rounded-md border border-line p-2" aria-label={d.toDateString()}>
              <h3 className="mb-1 text-xs font-semibold text-muted">{d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</h3>
              {items.length === 0 ? <p className="text-xs text-muted">-</p> : <ul className="space-y-1">{items.map((a: Row) => <li key={a.id} className="rounded bg-surface2 p-1.5 text-xs"><strong>{new Date(a.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong> {a.patient}<br /><span className="text-muted">{a.doctor}</span><div className="mt-0.5"><StatusBadge status={a.status} /></div></li>)}</ul>}
            </section>
          );
        })}
      </div>
      {!loading && !(data?.data ?? []).length && <EmptyState title="No appointments this week" />}
    </div>
  );
}

function CreateDialog({ open, onClose, onDone, docs }: { open: boolean; onClose: () => void; onDone: () => void; docs: any[] }) {
  const [f, setF] = useState({ patient_id: '', doctor_id: '', date: '', time: '09:00', duration_min: '30', reason: '' });
  const [pq, setPq] = useState('');
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const pats = useAsync(() => (pq.length >= 2 ? get(`/api/patients?q=${encodeURIComponent(pq)}&pageSize=8`) : Promise.resolve({ data: [] })), [pq]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    try { await post('/api/appointments', { patient_id: Number(f.patient_id), doctor_id: Number(f.doctor_id), scheduled_at: `${f.date}T${f.time}`, duration_min: Number(f.duration_min), reason: f.reason }); onDone(); }
    catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="New appointment">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
        {err && <div className="sm:col-span-2"><Alert>{err}</Alert></div>}
        <TextField label="Find patient" value={pq} onChange={(e) => setPq(e.target.value)} hint="Type at least 2 letters of a name or MRN" />
        <SelectField label="Patient" required value={f.patient_id} onChange={set('patient_id')} error={fe.patient_id}><option value="">Select…</option>{(pats.data?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.last_name}, {p.first_name} ({p.mrn})</option>)}</SelectField>
        <SelectField label="Doctor" required value={f.doctor_id} onChange={set('doctor_id')} error={fe.doctor_id}><option value="">Select…</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.full_name} - {d.department}</option>)}</SelectField>
        <TextField label="Duration (minutes)" type="number" min={5} max={240} value={f.duration_min} onChange={set('duration_min')} error={fe.duration_min} />
        <TextField label="Date" type="date" required value={f.date} onChange={set('date')} error={fe.scheduled_at} />
        <TextField label="Time" type="time" required value={f.time} onChange={set('time')} />
        <div className="sm:col-span-2"><TextField label="Reason" value={f.reason} onChange={set('reason')} error={fe.reason} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save appointment</Button></div>
      </form>
    </Modal>
  );
}

function RescheduleDialog({ row, onClose, onDone }: { row: Row | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ date: '', time: '09:00' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!row) return; setBusy(true); setErr('');
    try { await patch(`/api/appointments/${row.id}`, { scheduled_at: `${f.date}T${f.time}` }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!row} onClose={onClose} title="Reschedule appointment">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {row && <p className="text-muted">{row.patient} with {row.doctor}, currently {fmtDateTime(row.scheduled_at)}</p>}
        {err && <Alert>{err}</Alert>}
        <TextField label="New date" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <TextField label="New time" type="time" required value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Reschedule</Button></div>
      </form>
    </Modal>
  );
}

