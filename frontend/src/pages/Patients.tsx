import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { get, post, fmtDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, isChild, sexToGender } from '../components/Avatar';
import { Button, DataTable, Modal, PageHeader, SelectField, StatusBadge, TextField, Toolbar, Alert, errMsg, fieldErrors, useAsync, useList, useToast, type Column } from '../components/ui';

interface Row { id: number; mrn: string; first_name: string; last_name: string; dob: string; sex: string; phone: string; status: string; primary_doctor: string | null }

export default function Patients() {
  const nav = useNavigate();
  const { can } = useAuth();
  const list = useList<Row>('/api/patients', 'name');
  const [open, setOpen] = useState(false);
  const cols: Column<Row>[] = [
    { key: 'mrn', label: 'MRN', sortKey: 'mrn', className: 'whitespace-nowrap' },
    { key: 'name', label: 'Name', sortKey: 'name', render: (r) => <span className="inline-flex items-center gap-2.5"><Avatar name={`${r.first_name} ${r.last_name}`} gender={sexToGender(r.sex, r.id)} seed={r.id} child={isChild(r.dob)} size="xs" />{r.last_name}, {r.first_name}</span> },
    { key: 'dob', label: 'Date of birth', sortKey: 'dob', render: (r) => fmtDate(r.dob) },
    { key: 'sex', label: 'Sex' },
    { key: 'phone', label: 'Phone' },
    { key: 'primary_doctor', label: 'Primary doctor' },
    { key: 'status', label: 'Status', sortKey: 'status', render: (r) => <StatusBadge status={r.status} /> },
  ];
  return (
    <div>
      <PageHeader title="Patients" subtitle="Synthetic patient registry" actions={can('patients.register') ? <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Register patient</Button> : undefined} />
      <div className="card-shadow rounded-xl border border-line bg-surface p-4">
        <Toolbar list={list} placeholder="Name, MRN or phone">
          <SelectField label="Status" value={list.state.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">All</option><option>Active</option><option>Inactive</option><option>Deceased</option>
          </SelectField>
        </Toolbar>
        <DataTable list={list} columns={cols} caption="Patients" onRowClick={(r) => nav(`/patients/${r.id}`)} empty="No patients match" />
      </div>
      <RegisterDialog open={open} onClose={() => setOpen(false)} onDone={(id) => nav(`/patients/${id}`)} />
    </div>
  );
}

function RegisterDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const blank = { first_name: '', last_name: '', dob: '', sex: 'Female', phone: '', email: '', address: '', primary_doctor_id: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const docs = useAsync(() => get('/api/staff?kind=doctor&pageSize=50'), []);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    try {
      const r = await post('/api/patients', { ...f, primary_doctor_id: f.primary_doctor_id ? Number(f.primary_doctor_id) : null });
      toast(`Patient registered (${r.mrn})`); setF(blank); onClose(); onDone(r.id);
    } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Register patient">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
        {err && <div className="sm:col-span-2"><Alert>{err}</Alert></div>}
        <TextField label="First name" required value={f.first_name} onChange={set('first_name')} error={fe.first_name} />
        <TextField label="Last name" required value={f.last_name} onChange={set('last_name')} error={fe.last_name} />
        <TextField label="Date of birth" type="date" required value={f.dob} onChange={set('dob')} error={fe.dob} />
        <SelectField label="Sex" required value={f.sex} onChange={set('sex')}><option>Female</option><option>Male</option><option>Other</option></SelectField>
        <TextField label="Phone" value={f.phone} onChange={set('phone')} error={fe.phone} />
        <TextField label="Email" type="email" value={f.email} onChange={set('email')} error={fe.email} />
        <div className="sm:col-span-2"><TextField label="Address" value={f.address} onChange={set('address')} error={fe.address} /></div>
        <div className="sm:col-span-2"><SelectField label="Primary doctor" value={f.primary_doctor_id} onChange={set('primary_doctor_id')}><option value="">Unassigned</option>{(docs.data?.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.full_name} — {d.department}</option>)}</SelectField></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Register</Button></div>
      </form>
    </Modal>
  );
}
