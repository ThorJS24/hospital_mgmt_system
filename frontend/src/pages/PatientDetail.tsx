import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { get, patch, post, money, fmtDate, fmtDateTime, toBase64 } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, isChild, sexToGender } from '../components/Avatar';
import { ClinicalNote } from '../components/UnsafeNote';
import { VitalsTrend } from '../components/VitalsTrend';
import { Alert, Button, Card, EmptyState, KV, PageHeader, SelectField, Spinner, StatusBadge, Tabs, TextArea, TextField, errMsg, fieldErrors, useAsync, useToast } from '../components/ui';

export default function PatientDetail() {
  const { id } = useParams();
  const { can, lab } = useAuth();
  const toast = useToast();
  const { data: p, loading, error, reload } = useAsync(() => get(`/api/patients/${id}`), [id]);
  const [tab, setTab] = useState('demographics');
  const [edit, setEdit] = useState(false);
  if (loading && !p) return <Spinner />;
  if (error || !p) return <Alert>{error ?? 'Not found'}</Alert>;
  const tabs = [
    { id: 'demographics', label: 'Demographics' },
    ...(p.appointments ? [{ id: 'appointments', label: 'Appointments' }] : []),
    ...(p.history ? [{ id: 'clinical', label: 'History & allergies' }, { id: 'vitals', label: 'Vitals' }, { id: 'consultations', label: 'Consultations' }, { id: 'procedures', label: 'Procedures' }] : []),
    ...(p.invoices ? [{ id: 'billing', label: 'Billing' }] : []),
    ...(p.documents ? [{ id: 'documents', label: 'Documents' }] : []),
  ];
  return (
    <div>
      <PageHeader leading={<Avatar name={`${p.first_name} ${p.last_name}`} gender={sexToGender(p.sex, p.id)} seed={p.id} child={isChild(p.dob)} size="lg" />} title={`${p.first_name} ${p.last_name}`} subtitle={`${p.mrn} · ${p.sex} · born ${fmtDate(p.dob)}`}
        actions={<>{p.admission && <StatusBadge status={`Admitted: ${p.admission.ward} ${p.admission.bed}`} tone="info" />}<StatusBadge status={p.status} />{can('patients.write') && <Button variant="secondary" onClick={() => setEdit(!edit)}>{edit ? 'Cancel' : 'Edit'}</Button>}</>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="mt-4 space-y-4">
        {tab === 'demographics' && (edit ? <EditForm p={p} onDone={() => { setEdit(false); reload(); toast('Patient updated'); }} canNotes={can('clinical.write')} /> : (
          <>
            <Card title="Demographics"><dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><KV label="Phone">{p.phone}</KV><KV label="Email">{p.email}</KV><KV label="Address">{p.address}</KV><KV label="Primary doctor">{p.primary_doctor}</KV><KV label="Record status">{p.status}</KV><KV label="Registered">{fmtDate(p.created_at)}</KV><KV label="Blood type">{p.blood_type}</KV><KV label="Marital status">{p.marital_status}</KV></dl></Card>
            <Card title="Insurance & identifiers"><dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><KV label="Insurance provider">{p.insurance_provider}</KV><KV label="Policy number"><span className="font-mono">{p.insurance_policy_masked}</span></KV><KV label="Group number">{p.insurance_group_no}</KV><KV label="National ID (SSN)"><span className="font-mono">{p.ssn_masked}</span></KV><KV label="Driver licence"><span className="font-mono">{p.drivers_license_masked}</span></KV></dl><p className="mt-3 text-xs text-muted">Identifiers are masked; synthetic values only.</p></Card>
            <Card title="Emergency contacts">{p.contacts.length ? <ul className="divide-y divide-line">{p.contacts.map((c: any) => <li key={c.id} className="flex flex-wrap justify-between gap-2 py-1.5"><span>{c.name} <span className="text-muted">({c.relationship})</span></span><span>{c.phone}</span></li>)}</ul> : <EmptyState title="No contacts" />}</Card>
            {lab.mode === 'vulnerable' && can('clinical.read') && <a className="text-sm text-primary hover:underline" target="_blank" rel="noreferrer" href={`/api/lab/patients/${p.id}/summary`}>Open legacy clinical summary</a>}
            {p.history && <Card title="Clinical notes"><ClinicalNote text={p.notes} /></Card>}
          </>
        ))}
        {tab === 'appointments' && <Card title="Appointments">{p.appointments.length ? <Rows head={['When', 'Doctor', 'Department', 'Reason', 'Status']} rows={p.appointments.map((a: any) => [fmtDateTime(a.scheduled_at), a.doctor, a.department, a.reason, <StatusBadge key="s" status={a.status} />])} /> : <EmptyState title="No appointments" />}</Card>}
        {tab === 'clinical' && <Clinical p={p} reload={reload} />}
        {tab === 'vitals' && <VitalsTrend patientId={p.id} canRecord={can('vitals.write')} />}
        {tab === 'consultations' && <PatientConsultations patientId={p.id} />}
        {tab === 'procedures' && <Card title="Procedures">{p.procedures.length ? <Rows head={['Date', 'Code', 'Procedure', 'Performed by', 'Cost', 'Outcome']} rows={p.procedures.map((x: any) => [fmtDate(x.performed_on), x.code, x.name, x.doctor, money(x.cost), <StatusBadge key="o" status={x.outcome === 'Successful' ? 'Completed' : 'Pending'} tone={x.outcome === 'Successful' ? 'ok' : 'warn'} />])} /> : <EmptyState title="No procedures recorded" />}</Card>}
        {tab === 'billing' && <Card title="Invoices">{p.invoices.length ? <Rows head={['Invoice', 'Issued', 'Total', 'Paid', 'Status']} rows={p.invoices.map((i: any) => [<Link key="l" className="text-primary hover:underline" to={`/billing?q=${i.invoice_no}`}>{i.invoice_no}</Link>, fmtDate(i.issued_on), money(i.total), money(i.paid), <StatusBadge key="s" status={i.status} />])} /> : <EmptyState title="No invoices" />}</Card>}
        {tab === 'documents' && <Documents p={p} reload={reload} />}
      </div>
    </div>
  );
}

const Rows = ({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) => (
  <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-muted"><tr>{head.map((h) => <th key={h} className="px-2 py-1">{h}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-line">{r.map((c, j) => <td key={j} className="px-2 py-1.5">{c}</td>)}</tr>)}</tbody></table></div>
);

function EditForm({ p, onDone, canNotes }: { p: any; onDone: () => void; canNotes: boolean }) {
  const [f, setF] = useState({ phone: p.phone, email: p.email, address: p.address, status: p.status, notes: p.notes ?? '' });
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    try { const { notes, ...rest } = f; await patch(`/api/patients/${p.id}`, canNotes ? { ...rest, notes } : rest); onDone(); } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  return (
    <Card title="Edit patient"><form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      {err && <div className="sm:col-span-2"><Alert>{err}</Alert></div>}
      <TextField label="Phone" value={f.phone} onChange={set('phone')} error={fe.phone} />
      <TextField label="Email" type="email" value={f.email} onChange={set('email')} error={fe.email} />
      <TextField label="Address" value={f.address} onChange={set('address')} error={fe.address} />
      <SelectField label="Record status" value={f.status} onChange={set('status')}><option>Active</option><option>Inactive</option><option>Deceased</option></SelectField>
      {canNotes && <div className="sm:col-span-2"><TextArea label="Clinical notes" value={f.notes} onChange={set('notes')} error={fe.notes} /></div>}
      <div className="sm:col-span-2"><Button type="submit" loading={busy}>Save changes</Button></div>
    </form></Card>
  );
}

function Clinical({ p, reload }: { p: any; reload: () => void }) {
  const { can } = useAuth(); const toast = useToast();
  const [a, setA] = useState({ allergen: '', reaction: '', severity: 'Mild' });
  const [h, setH] = useState({ condition: '', diagnosed_on: '', notes: '' });
  const [err, setErr] = useState('');
  const add = async (url: string, body: object, reset: () => void) => { setErr(''); try { await post(url, body); reset(); reload(); toast('Saved'); } catch (x) { setErr(errMsg(x)); } };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {err && <div className="lg:col-span-2"><Alert>{err}</Alert></div>}
      <Card title="Allergies">
        {p.allergies.length ? <ul className="divide-y divide-line">{p.allergies.map((x: any) => <li key={x.id} className="flex items-center justify-between py-1.5"><span>{x.allergen} <span className="text-muted">- {x.reaction || 'no reaction recorded'}</span></span><StatusBadge status={x.severity} /></li>)}</ul> : <EmptyState title="No known allergies recorded" />}
        {can('clinical.write') && <form className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void add(`/api/patients/${p.id}/allergies`, a, () => setA({ allergen: '', reaction: '', severity: 'Mild' })); }}>
          <TextField label="Allergen" required value={a.allergen} onChange={(e) => setA({ ...a, allergen: e.target.value })} />
          <TextField label="Reaction" value={a.reaction} onChange={(e) => setA({ ...a, reaction: e.target.value })} />
          <SelectField label="Severity" value={a.severity} onChange={(e) => setA({ ...a, severity: e.target.value })}><option>Mild</option><option>Moderate</option><option>Severe</option></SelectField>
          <div className="sm:col-span-3"><Button type="submit" variant="secondary">Add allergy</Button></div></form>}
      </Card>
      <Card title="Medical history">
        {p.history.length ? <ul className="divide-y divide-line">{p.history.map((x: any) => <li key={x.id} className="py-1.5"><span className="font-medium">{x.condition}</span> <span className="text-muted">· since {fmtDate(x.diagnosed_on)}</span>{x.notes && <p className="text-muted">{x.notes}</p>}</li>)}</ul> : <EmptyState title="No history recorded" />}
        {can('clinical.write') && <form className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void add(`/api/patients/${p.id}/history`, { ...h, diagnosed_on: h.diagnosed_on || undefined }, () => setH({ condition: '', diagnosed_on: '', notes: '' })); }}>
          <TextField label="Condition" required value={h.condition} onChange={(e) => setH({ ...h, condition: e.target.value })} />
          <TextField label="Diagnosed on" type="date" value={h.diagnosed_on} onChange={(e) => setH({ ...h, diagnosed_on: e.target.value })} />
          <div className="sm:col-span-2"><TextField label="Notes" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>
          <div className="sm:col-span-2"><Button type="submit" variant="secondary">Add history entry</Button></div></form>}
      </Card>
    </div>
  );
}

function Documents({ p, reload }: { p: any; reload: () => void }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true); setErr('');
    try {
      if (file.size > 512 * 1024) throw new Error('File exceeds the 512 KB limit');
      const content_base64 = toBase64(await file.arrayBuffer());
      await post(`/api/patients/${p.id}/documents`, { filename: file.name, content_base64 });
      toast('Document uploaded'); reload();
    } catch (x) { setErr(errMsg(x)); }
    setBusy(false); if (ref.current) ref.current.value = '';
  };
  return (
    <Card title="Documents" actions={<><input ref={ref} type="file" className="sr-only-live" id="doc-upload" aria-label="Choose document" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} /><Button loading={busy} onClick={() => ref.current?.click()}><Upload className="h-4 w-4" />Upload</Button></>}>
      <p className="mb-2 text-xs text-muted">Accepted: PDF, PNG, JPG, TXT up to 512 KB. Synthetic files only.</p>
      {err && <Alert>{err}</Alert>}
      {p.documents.length ? <Rows head={['File', 'Type', 'Size', 'Uploaded', '']} rows={p.documents.map((d: any) => [d.filename, d.content_type, `${(d.size_bytes / 1024).toFixed(1)} KB`, fmtDateTime(d.created_at), <a key="a" className="text-primary hover:underline" target="_blank" rel="noreferrer" href={`/api/documents/${d.id}`}>Open</a>])} /> : <EmptyState title="No documents" />}
    </Card>
  );
}

function PatientConsultations({ patientId }: { patientId: number }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useAsync(() => get(`/api/consultations?patient_id=${patientId}&pageSize=50`), [patientId]);
  const start = async () => {
    try { const r = await post('/api/consultations', { patient_id: patientId }); navigate(`/consultations/${r.id}`); } catch (x) { toast(errMsg(x), 'danger'); }
  };
  return (
    <Card title="Consultations" actions={can('consultations.write') ? <Button onClick={() => void start()}>Start consultation</Button> : undefined}>
      {q.error ? <Alert>{q.error}</Alert> : q.loading && !q.data ? <Spinner /> : (q.data?.data ?? []).length
        ? <Rows head={['Started', 'Doctor', 'Primary diagnosis', 'Status', '']} rows={q.data.data.map((c: any) => [fmtDateTime(c.created_at), c.doctor, c.primary_diagnosis ?? '-', <StatusBadge key="s" status={c.status} tone={c.status === 'Signed' ? 'ok' : 'warn'} />, <Link key="l" className="text-primary hover:underline" to={`/consultations/${c.id}`}>Open</Link>])} />
        : <EmptyState title="No consultations yet" />}
    </Card>
  );
}
