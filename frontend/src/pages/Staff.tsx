import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { get, post, put, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, staffGender } from '../components/Avatar';
import { Alert, Button, DataTable, EmptyState, KV, Modal, PageHeader, SelectField, Spinner, StatusBadge, TextField, Toolbar, errMsg, fieldErrors, useAsync, useList, useToast, type Column } from '../components/ui';

interface Row { id: number; staff_code: string; full_name: string; job_title: string; email: string; availability: string; schedule: string; department: string; department_id: number }
const AVAIL = ['Available', 'In Surgery', 'On Leave', 'Off Duty'];

export default function Staff() {
  const { can } = useAuth(); const toast = useToast();
  const list = useList<Row>('/api/staff', 'name', 15, { urlQuery: true });
  const depts = useAsync(() => get('/api/departments'), []);
  const [sel, setSel] = useState<number | null>(null);
  const [form, setForm] = useState<Row | 'new' | null>(null);
  const cols: Column<Row>[] = [
    { key: 'staff_code', label: 'Code', sortKey: 'code' },
    { key: 'full_name', label: 'Name', sortKey: 'name', render: (r) => <span className="inline-flex items-center gap-2.5"><Avatar name={r.full_name} gender={staffGender(r.full_name, r.id)} seed={r.id + 40} size="xs" />{r.full_name}</span> },
    { key: 'job_title', label: 'Role', sortKey: 'title' },
    { key: 'department', label: 'Department', sortKey: 'department' },
    { key: 'availability', label: 'Availability', sortKey: 'availability', render: (r) => <StatusBadge status={r.availability} /> },
    { key: 'schedule', label: 'Schedule' },
  ];
  return (
    <div>
      <PageHeader image="/img/hospital/h3.jpg" title="Staff directory" subtitle="Fictional staff - not real medical professionals" actions={can('staff.manage') ? <Button onClick={() => setForm('new')}><Plus className="h-4 w-4" />Add staff</Button> : undefined} />
      <div className="card-shadow rounded-xl border border-line bg-surface p-4">
        <Toolbar list={list} placeholder="Name, code or role">
          <SelectField label="Department" value={list.state.filters.department_id ?? ''} onChange={(e) => list.setFilter('department_id', e.target.value)}><option value="">All</option>{(depts.data?.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</SelectField>
          <SelectField label="Availability" value={list.state.filters.availability ?? ''} onChange={(e) => list.setFilter('availability', e.target.value)}><option value="">All</option>{AVAIL.map((a) => <option key={a}>{a}</option>)}</SelectField>
        </Toolbar>
        <DataTable list={list} columns={cols} caption="Staff" onRowClick={(r) => setSel(r.id)} actions={can('staff.manage') ? (r) => <Button variant="ghost" onClick={() => setForm(r)}>Edit</Button> : undefined} />
      </div>
      <Profile id={sel} onClose={() => setSel(null)} />
      <StaffForm target={form} depts={depts.data?.data ?? []} onClose={() => setForm(null)} onDone={() => { setForm(null); list.reload(); toast('Staff saved'); }} />
    </div>
  );
}

function Profile({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data, loading, error } = useAsync(() => (id ? get(`/api/staff/${id}`) : Promise.resolve(null)), [id]);
  return (
    <Modal open={id !== null} onClose={onClose} title="Staff profile" wide>
      {loading ? <Spinner /> : error ? <Alert>{error}</Alert> : data && (
        <div className="space-y-4">
          <div className="flex items-center gap-4"><Avatar name={data.full_name} gender={staffGender(data.full_name, data.id)} seed={data.id + 40} size="lg" /><div><p className="text-lg font-semibold">{data.full_name}</p><p className="text-muted">{data.job_title} · {data.department}</p></div></div>
          <dl className="grid gap-4 sm:grid-cols-3"><KV label="Name">{data.full_name}</KV><KV label="Code">{data.staff_code}</KV><KV label="Role">{data.job_title}</KV><KV label="Department">{data.department}</KV><KV label="Email">{data.email}</KV><KV label="Availability"><StatusBadge status={data.availability} /></KV><KV label="Work schedule">{data.schedule}</KV></dl>
          {data.appointments && <div><h3 className="mb-1 font-semibold">Assigned appointments</h3>{data.appointments.length ? <ul className="divide-y divide-line">{data.appointments.map((a: any) => <li key={a.id} className="flex justify-between py-1.5"><span>{fmtDateTime(a.scheduled_at)} · {a.patient}</span><StatusBadge status={a.status} /></li>)}</ul> : <EmptyState title="No upcoming appointments" />}</div>}
        </div>
      )}
    </Modal>
  );
}

function StaffForm({ target, depts, onClose, onDone }: { target: Row | 'new' | null; depts: any[]; onClose: () => void; onDone: () => void }) {
  const isNew = target === 'new';
  const init = { staff_code: '', full_name: '', job_title: '', department_id: '', email: '', availability: 'Available', schedule: 'Mon-Fri 08:00-16:00' };
  const [f, setF] = useState(init);
  const [key, setKey] = useState<unknown>(null);
  if (target !== key) { setKey(target); setF(target && target !== 'new' ? { ...init, ...target, department_id: String(target.department_id) } : init); }
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof init) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    const body = { full_name: f.full_name, job_title: f.job_title, department_id: Number(f.department_id), email: f.email, availability: f.availability, schedule: f.schedule };
    try { if (isNew) await post('/api/staff', { ...body, staff_code: f.staff_code }); else await put(`/api/staff/${(target as Row).id}`, body); onDone(); } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  return (
    <Modal open={target !== null} onClose={onClose} title={isNew ? 'Add staff member' : 'Edit staff member'}>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
        {err && <div className="sm:col-span-2"><Alert>{err}</Alert></div>}
        {isNew && <TextField label="Staff code" required value={f.staff_code} onChange={set('staff_code')} hint="e.g. DOC-020" error={fe.staff_code} />}
        <TextField label="Full name" required value={f.full_name} onChange={set('full_name')} error={fe.full_name} />
        <TextField label="Job title" required value={f.job_title} onChange={set('job_title')} error={fe.job_title} />
        <SelectField label="Department" required value={f.department_id} onChange={set('department_id')} error={fe.department_id}><option value="">Select…</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</SelectField>
        <TextField label="Email" type="email" required value={f.email} onChange={set('email')} error={fe.email} />
        <SelectField label="Availability" value={f.availability} onChange={set('availability')}>{AVAIL.map((a) => <option key={a}>{a}</option>)}</SelectField>
        <TextField label="Work schedule" value={f.schedule} onChange={set('schedule')} />
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}
