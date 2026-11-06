import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { get, post, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SelectField, Spinner, StatusBadge, Tabs, TextField, errMsg, useAsync, useToast } from '../components/ui';
import { DischargeSummary } from '../components/DischargeSummary';

export default function Admissions() {
  const { can } = useAuth(); const toast = useToast();
  const [tab, setTab] = useState('Admitted');
  const wards = useAsync(() => get('/api/wards'), []);
  const adm = useAsync(() => get(`/api/admissions?status=${tab}`), [tab]);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<number | null>(null);
  const manage = can('admissions.manage');
  const refresh = () => { wards.reload(); adm.reload(); };
  const discharge = async (id: number) => { try { await post(`/api/admissions/${id}/discharge`); toast('Patient discharged'); refresh(); } catch (x) { toast(errMsg(x), 'danger'); } };
  return (
    <div className="space-y-4">
      <PageHeader image="/img/hospital/h2.jpg" title="Admissions" subtitle="Inpatient wards and bed management" actions={manage ? <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Admit patient</Button> : undefined} />
      {wards.loading && !wards.data ? <Spinner /> : wards.error ? <Alert>{wards.error}</Alert> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(wards.data ?? []).map((w: any) => (
            <Card key={w.id} title={w.name}>
              <p className="mb-2 text-xs text-muted">{w.department} · {w.available} of {w.beds} beds available</p>
              <ul className="grid grid-cols-2 gap-1.5" aria-label={`Beds in ${w.name}`}>
                {w.bedList.map((b: any) => <li key={b.id} className={`rounded border px-2 py-1 text-xs ${b.admission_id ? 'border-warn/50 bg-warn/10' : 'border-line'}`} title={b.patient ?? 'Available'}><strong>{b.label}</strong><br />{b.patient ? b.patient : <span className="text-ok">Available</span>}</li>)}
              </ul>
            </Card>
          ))}
        </div>
      )}
      <Card title="Admission records">
        <Tabs tabs={[{ id: 'Admitted', label: 'Currently admitted' }, { id: 'Discharged', label: 'Discharged' }]} value={tab} onChange={setTab} />
        <div className="mt-3 overflow-x-auto">
          {adm.error ? <Alert>{adm.error}</Alert> : adm.loading ? <Spinner /> : !(adm.data?.data ?? []).length ? <EmptyState title="No admissions" /> : (
            <table className="w-full text-left text-sm"><caption className="sr-only-live">Admissions</caption><thead className="text-xs uppercase text-muted"><tr><th className="px-2 py-1">Patient</th><th>Ward / bed</th><th>Doctor</th><th>Admitted</th><th>{tab === 'Discharged' ? 'Discharged' : 'Reason'}</th><th>Status</th><th /></tr></thead>
              <tbody>{adm.data.data.map((a: any) => <tr key={a.id} className="border-t border-line"><td className="px-2 py-1.5">{a.patient} <span className="text-muted">({a.mrn})</span></td><td>{a.ward} · {a.bed}</td><td>{a.doctor}</td><td>{fmtDateTime(a.admitted_at)}</td><td>{tab === 'Discharged' ? fmtDateTime(a.discharged_at) : a.reason}</td><td><StatusBadge status={a.status} /></td><td className="text-right"><span className="inline-flex flex-wrap justify-end gap-1.5">{can('discharge.read') && <Button variant="ghost" onClick={() => setSummary(a.id)}>Summary</Button>}{manage && a.status === 'Admitted' && <Button variant="secondary" onClick={() => void discharge(a.id)}>Discharge</Button>}</span></td></tr>)}</tbody></table>
          )}
        </div>
      </Card>
      <DischargeSummary admissionId={summary} canWrite={can('discharge.write')} onClose={() => setSummary(null)} />
      <AdmitDialog open={open} wards={wards.data ?? []} onClose={() => setOpen(false)} onDone={() => { setOpen(false); refresh(); toast('Patient admitted'); }} />
    </div>
  );
}

function AdmitDialog({ open, onClose, onDone, wards }: { open: boolean; onClose: () => void; onDone: () => void; wards: any[] }) {
  const [f, setF] = useState({ patient_id: '', bed_id: '', doctor_id: '', reason: '' });
  const [pq, setPq] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const pats = useAsync(() => (pq.length >= 2 ? get(`/api/patients?q=${encodeURIComponent(pq)}&pageSize=8`) : Promise.resolve({ data: [] })), [pq]);
  const docs = useAsync(() => get('/api/staff?kind=doctor&pageSize=50'), []);
  const free = wards.flatMap((w) => w.bedList.filter((b: any) => !b.admission_id).map((b: any) => ({ ...b, ward: w.name })));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await post('/api/admissions', { patient_id: Number(f.patient_id), bed_id: Number(f.bed_id), doctor_id: Number(f.doctor_id), reason: f.reason }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Admit patient">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <TextField label="Find patient" value={pq} onChange={(e) => setPq(e.target.value)} hint="Type at least 2 letters" />
        <SelectField label="Patient" required value={f.patient_id} onChange={set('patient_id')}><option value="">Select…</option>{(pats.data?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.last_name}, {p.first_name} ({p.mrn})</option>)}</SelectField>
        <SelectField label="Available bed" required value={f.bed_id} onChange={set('bed_id')}><option value="">Select…</option>{free.map((b) => <option key={b.id} value={b.id}>{b.ward} · {b.label}</option>)}</SelectField>
        <SelectField label="Responsible doctor" required value={f.doctor_id} onChange={set('doctor_id')}><option value="">Select…</option>{(docs.data?.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</SelectField>
        <TextField label="Reason" value={f.reason} onChange={set('reason')} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Admit</Button></div>
      </form>
    </Modal>
  );
}
