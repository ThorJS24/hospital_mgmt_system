import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { get, post, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, DataTable, Modal, PageHeader, SelectField, StatusBadge, Tabs, TextField, Toolbar, errMsg, useAsync, useList, useToast, type Column } from '../components/ui';

interface Row { id: number; status: string; requested_at: string; patient: string; mrn: string; test: string; test_code: string; unit: string; reference_range: string; ordering_doctor: string; technician: string | null; result_value: string | null; result_comment: string | null; result_approved: boolean | null }

export default function Laboratory() {
  const { can, user } = useAuth(); const toast = useToast();
  const list = useList<Row>('/api/laboratory/requests');
  const [tab, setTab] = useState('requests');
  const [create, setCreate] = useState(false);
  const [result, setResult] = useState<Row | null>(null);
  const act = async (r: Row, what: 'assign' | 'approve') => {
    try { await post(`/api/laboratory/requests/${r.id}/${what}`, {}); toast(what === 'assign' ? 'Assigned to you' : 'Result approved'); list.reload(); } catch (x) { toast(errMsg(x), 'danger'); }
  };
  const cols: Column<Row>[] = [
    { key: 'id', label: 'Request', render: (r) => `LR-${String(r.id).padStart(4, '0')}` },
    { key: 'patient', label: 'Patient', render: (r) => <>{r.patient} <span className="text-muted">({r.mrn})</span></> },
    { key: 'test', label: 'Test', render: (r) => `${r.test_code} · ${r.test}` },
    { key: 'ordering_doctor', label: 'Ordered by' },
    { key: 'technician', label: 'Technician', render: (r) => r.technician ?? '-' },
    { key: 'result', label: 'Result', render: (r) => (r.result_value ? <span>{r.result_value} {r.unit} <span className="text-xs text-muted">{r.result_approved ? '(approved)' : '(unapproved)'}</span></span> : '-') },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'requested_at', label: 'Requested', render: (r) => fmtDateTime(r.requested_at) },
  ];
  return (
    <div>
      <PageHeader title="Laboratory" actions={can('lab.request') ? <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New request</Button> : undefined} />
      <Alert tone="warn">All laboratory results are synthetic and unsuitable for clinical decision-making.</Alert>
      <div className="mt-3"><Tabs tabs={[{ id: 'requests', label: 'Requests' }, { id: 'catalogue', label: 'Test catalogue' }, { id: 'docs', label: 'Reference documents' }]} value={tab} onChange={setTab} /></div>
      <div className="mt-4 rounded-lg border border-line bg-surface p-4">
        {tab === 'requests' && <>
          <Toolbar list={list} placeholder="Patient, MRN or test">
            <SelectField label="Status" value={list.state.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}><option value="">All</option>{['Requested', 'In progress', 'Resulted', 'Approved', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}</SelectField>
          </Toolbar>
          <DataTable list={list} columns={cols} caption="Laboratory requests" actions={(r) => (
            <div className="flex justify-end gap-1">
              {can('lab.result') && ['Requested', 'In progress'].includes(r.status) && <Button variant="secondary" onClick={() => void act(r, 'assign')} disabled={r.status === 'In progress' && r.technician === user?.fullName}>{r.status === 'Requested' ? 'Take' : 'Reassign to me'}</Button>}
              {can('lab.result') && r.status === 'In progress' && <Button onClick={() => setResult(r)}>Enter result</Button>}
              {can('lab.approve') && r.status === 'Resulted' && <Button onClick={() => void act(r, 'approve')}>Approve</Button>}
            </div>)} />
        </>}
        {tab === 'catalogue' && <Catalogue />}
        {tab === 'docs' && <><Docs /></>}
      </div>
      <CreateDialog open={create} onClose={() => setCreate(false)} onDone={() => { setCreate(false); list.reload(); toast('Laboratory request created'); }} />
      <ResultDialog row={result} onClose={() => setResult(null)} onDone={() => { setResult(null); list.reload(); toast('Result recorded'); }} />
    </div>
  );
}

function Catalogue() {
  const { data, loading, error } = useAsync(() => get('/api/laboratory/tests'), []);
  if (error) return <Alert>{error}</Alert>;
  return <div className="overflow-x-auto" aria-busy={loading}><table className="w-full text-left text-sm"><caption className="sr-only-live">Test catalogue</caption><thead className="text-xs uppercase text-muted"><tr><th className="px-2 py-1">Code</th><th>Name</th><th>Unit</th><th>Reference range</th><th>Price</th></tr></thead><tbody>{(data?.data ?? []).map((t: any) => <tr key={t.id} className="border-t border-line"><td className="px-2 py-1.5">{t.code}</td><td>{t.name}</td><td>{t.unit}</td><td>{t.reference_range}</td><td>${t.price.toFixed(2)}</td></tr>)}</tbody></table></div>;
}

function Docs() {
  const { data, error } = useAsync(() => get('/api/laboratory/reference-docs'), []);
  const [open, setOpen] = useState<{ name: string; text: string } | null>(null);
  if (error) return <Alert>{error}</Alert>;
  return (
    <div>
      <ul className="divide-y divide-line">{(data?.data ?? []).map((n: string) => <li key={n} className="flex items-center justify-between py-1.5"><span>{n}</span><Button variant="secondary" onClick={async () => setOpen({ name: n, text: await get(`/api/laboratory/reference-docs/${encodeURIComponent(n)}`) })}>View</Button></li>)}</ul>
      <Modal open={!!open} title={open?.name ?? ''} onClose={() => setOpen(null)}><pre className="whitespace-pre-wrap text-sm">{open?.text}</pre></Modal>
    </div>
  );
}

function CreateDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const [f, setF] = useState({ patient_id: '', test_id: '', ordering_doctor_id: '' });
  const [pq, setPq] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const pats = useAsync(() => (pq.length >= 2 ? get(`/api/patients?q=${encodeURIComponent(pq)}&pageSize=8`) : Promise.resolve({ data: [] })), [pq]);
  const tests = useAsync(() => get('/api/laboratory/tests'), []);
  const docs = useAsync(() => get('/api/staff?kind=doctor&pageSize=50'), []);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await post('/api/laboratory/requests', { patient_id: Number(f.patient_id), test_id: Number(f.test_id), ...(user?.role !== 'doctor' && { ordering_doctor_id: Number(f.ordering_doctor_id) }) }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="New laboratory request">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <TextField label="Find patient" value={pq} onChange={(e) => setPq(e.target.value)} hint="Type at least 2 letters" />
        <SelectField label="Patient" required value={f.patient_id} onChange={(e) => setF({ ...f, patient_id: e.target.value })}><option value="">Select…</option>{(pats.data?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.last_name}, {p.first_name} ({p.mrn})</option>)}</SelectField>
        <SelectField label="Test" required value={f.test_id} onChange={(e) => setF({ ...f, test_id: e.target.value })}><option value="">Select…</option>{(tests.data?.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</SelectField>
        {user?.role !== 'doctor' && <SelectField label="Ordering doctor" required value={f.ordering_doctor_id} onChange={(e) => setF({ ...f, ordering_doctor_id: e.target.value })}><option value="">Select…</option>{(docs.data?.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</SelectField>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create request</Button></div>
      </form>
    </Modal>
  );
}

function ResultDialog({ row, onClose, onDone }: { row: Row | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ value: '', comment: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!row) return; setBusy(true); setErr('');
    try { await post(`/api/laboratory/requests/${row.id}/result`, f); setF({ value: '', comment: '' }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!row} onClose={onClose} title="Enter synthetic result">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {row && <p className="text-muted">{row.patient} - {row.test} (reference {row.reference_range} {row.unit})</p>}
        {err && <Alert>{err}</Alert>}
        <TextField label={`Value${row?.unit ? ` (${row.unit})` : ''}`} required value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        <TextField label="Comment" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} hint="Results are synthetic; mention nothing clinical." />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save result</Button></div>
      </form>
    </Modal>
  );
}
