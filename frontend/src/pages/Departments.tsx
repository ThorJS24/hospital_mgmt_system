import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, EmptyState, Modal, PageHeader, Spinner, StatusBadge, TextArea, TextField, errMsg, fieldErrors, useAsync, useToast } from '../components/ui';

export default function Departments() {
  const { can } = useAuth(); const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get('/api/departments'), []);
  const [sel, setSel] = useState<number | null>(null);
  const [form, setForm] = useState<any | 'new' | null>(null);
  return (
    <div>
      <PageHeader image="/img/hospital/h1.jpg" title="Departments" subtitle="Clinical and support services" actions={can('departments.manage') ? <Button onClick={() => setForm('new')}><Plus className="h-4 w-4" />Add department</Button> : undefined} />
      {loading && !data ? <Spinner /> : error ? <Alert>{error}</Alert> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {data.data.map((d: any) => (
            <Card key={d.id} title={d.name} actions={can('departments.manage') && <Button variant="ghost" onClick={() => setForm(d)}>Edit</Button>}>
              <p className="text-muted">{d.description}</p>
              <p className="mt-2 text-xs"><strong>Services:</strong> {d.services || '-'}</p>
              <p className="mt-2 text-xs text-muted">{d.staff_count} staff · {d.appointments_today} appointments today</p>
              <Button variant="secondary" className="mt-3" onClick={() => setSel(d.id)}>View details</Button>
            </Card>
          ))}
        </div>
      )}
      <Detail id={sel} onClose={() => setSel(null)} />
      <DeptForm target={form} onClose={() => setForm(null)} onDone={() => { setForm(null); reload(); toast('Department saved'); }} />
    </div>
  );
}

function Detail({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data, loading, error } = useAsync(() => (id ? get(`/api/departments/${id}`) : Promise.resolve(null)), [id]);
  return (
    <Modal open={id !== null} onClose={onClose} title={data?.name ?? 'Department'} wide>
      {loading ? <Spinner /> : error ? <Alert>{error}</Alert> : data && (
        <div className="grid gap-4 md:grid-cols-2">
          <div><h3 className="mb-1 font-semibold">Staff</h3><ul className="divide-y divide-line">{data.staff.map((s: any) => <li key={s.id} className="flex justify-between py-1.5"><span>{s.full_name} <span className="text-muted">· {s.job_title}</span></span><StatusBadge status={s.availability} /></li>)}</ul></div>
          <div><h3 className="mb-1 font-semibold">Appointment summary</h3>{data.appointment_summary.length ? <ul className="divide-y divide-line">{data.appointment_summary.map((s: any) => <li key={s.status} className="flex justify-between py-1.5"><StatusBadge status={s.status} /><strong>{s.n}</strong></li>)}</ul> : <EmptyState title="No appointments" />}</div>
        </div>
      )}
    </Modal>
  );
}

function DeptForm({ target, onClose, onDone }: { target: any | 'new' | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', description: '', services: '' });
  const [key, setKey] = useState<unknown>(null);
  if (target !== key) { setKey(target); setF(target && target !== 'new' ? { name: target.name, description: target.description, services: target.services } : { name: '', description: '', services: '' }); }
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    try { if (target === 'new') await post('/api/departments', f); else await put(`/api/departments/${target.id}`, f); onDone(); } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  return (
    <Modal open={target !== null} onClose={onClose} title={target === 'new' ? 'Add department' : 'Edit department'}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <TextField label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={fe.name} />
        <TextArea label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} error={fe.description} />
        <TextArea label="Services" value={f.services} onChange={(e) => setF({ ...f, services: e.target.value })} error={fe.services} hint="Comma-separated" />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}
