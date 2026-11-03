import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { get, post, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MedicationLookup, useLabMode } from '../components/vulnerable/LabTools';
import { Alert, Button, DataTable, Modal, PageHeader, SelectField, Spinner, StatusBadge, Tabs, TextField, Toolbar, errMsg, useAsync, useList, useToast, type Column } from '../components/ui';

interface Rx { id: number; status: string; dispensing_status: string; created_at: string; patient: string; mrn: string; doctor: string; item_count: number }
interface Med { id: number; code: string; name: string; form: string; strength: string; stock: number }

export default function Pharmacy() {
  const { can } = useAuth(); const toast = useToast();
  const [tab, setTab] = useState('rx');
  const rx = useList<Rx>('/api/pharmacy/prescriptions');
  const meds = useList<Med>('/api/pharmacy/medications');
  const [detail, setDetail] = useState<number | null>(null);
  const [create, setCreate] = useState(false);
  const lab = useLabMode();
  const dispense = async (id: number) => { try { await post(`/api/pharmacy/prescriptions/${id}/dispense`); toast('Prescription dispensed'); rx.reload(); meds.reload(); setDetail(null); } catch (x) { toast(errMsg(x), 'danger'); } };
  const rxCols: Column<Rx>[] = [
    { key: 'id', label: 'Rx', render: (r) => `RX-${String(r.id).padStart(4, '0')}` },
    { key: 'patient', label: 'Patient', render: (r) => <>{r.patient} <span className="text-muted">({r.mrn})</span></> },
    { key: 'doctor', label: 'Prescriber' },
    { key: 'item_count', label: 'Items' },
    { key: 'created_at', label: 'Issued', render: (r) => fmtDateTime(r.created_at) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'dispensing_status', label: 'Dispensing', render: (r) => <StatusBadge status={r.dispensing_status} /> },
  ];
  const medCols: Column<Med>[] = [
    { key: 'code', label: 'Code' }, { key: 'name', label: 'Medication' }, { key: 'form', label: 'Form' }, { key: 'strength', label: 'Strength' },
    { key: 'stock', label: 'Stock', render: (m) => <span>{m.stock}{m.stock < 100 && <span className="ml-1 text-xs text-warn">(low)</span>}</span> },
  ];
  return (
    <div>
      <PageHeader title="Pharmacy" actions={can('prescriptions.write') ? <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New prescription</Button> : undefined} />
      <Alert tone="warn">Prescriptions are synthetic records and not medical instructions.</Alert>
      <div className="mt-3"><Tabs tabs={[{ id: 'rx', label: 'Prescriptions' }, { id: 'meds', label: 'Medication catalogue' }]} value={tab} onChange={setTab} /></div>
      <div className="mt-4 rounded-lg border border-line bg-surface p-4">
        {tab === 'rx' ? <>
          <Toolbar list={rx} placeholder="Patient or MRN">
            <SelectField label="Dispensing" value={rx.state.filters.dispensing_status ?? ''} onChange={(e) => rx.setFilter('dispensing_status', e.target.value)}><option value="">All</option><option>Pending</option><option>Dispensed</option><option>Partially dispensed</option></SelectField>
          </Toolbar>
          <DataTable list={rx} columns={rxCols} caption="Prescriptions" onRowClick={(r) => setDetail(r.id)} />
        </> : <>
          <Toolbar list={meds} placeholder="Name or code" />
          <DataTable list={meds} columns={medCols} caption="Medications" />
        </>}
      </div>
      {lab && <div className="mt-4 grid gap-4 lg:grid-cols-2"><MedicationLookup /></div>}
      <Detail id={detail} onClose={() => setDetail(null)} onDispense={can('prescriptions.dispense') ? dispense : undefined} />
      <CreateDialog open={create} onClose={() => setCreate(false)} onDone={() => { setCreate(false); rx.reload(); toast('Prescription created'); }} />
    </div>
  );
}

function Detail({ id, onClose, onDispense }: { id: number | null; onClose: () => void; onDispense?: (id: number) => void }) {
  const { data, loading, error } = useAsync(() => (id ? get(`/api/pharmacy/prescriptions/${id}`) : Promise.resolve(null)), [id]);
  return (
    <Modal open={id !== null} onClose={onClose} title={id ? `Prescription RX-${String(id).padStart(4, '0')}` : ''} wide>
      {loading ? <Spinner /> : error ? <Alert>{error}</Alert> : data && (
        <div className="space-y-3">
          <p>{data.patient} ({data.mrn}) · prescribed by {data.doctor} · <StatusBadge status={data.dispensing_status} /></p>
          <table className="w-full text-left text-sm"><thead className="text-xs uppercase text-muted"><tr><th className="py-1">Medication</th><th>Quantity</th><th>Dosage</th></tr></thead><tbody>{data.items.map((i: any) => <tr key={i.id} className="border-t border-line"><td className="py-1.5">{i.medication} {i.strength} ({i.form})</td><td>{i.quantity}</td><td>{i.dosage}</td></tr>)}</tbody></table>
          <p className="text-xs text-muted">{data.notice}</p>
          {onDispense && data.status === 'Active' && data.dispensing_status !== 'Dispensed' && <div className="flex justify-end"><Button onClick={() => onDispense(data.id)}>Dispense</Button></div>}
        </div>
      )}
    </Modal>
  );
}

function CreateDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const [patient, setPatient] = useState(''); const [pq, setPq] = useState(''); const [doctor, setDoctor] = useState('');
  const [items, setItems] = useState([{ medication_id: '', quantity: '10', dosage: '' }]);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const pats = useAsync(() => (pq.length >= 2 ? get(`/api/patients?q=${encodeURIComponent(pq)}&pageSize=8`) : Promise.resolve({ data: [] })), [pq]);
  const meds = useAsync(() => get('/api/pharmacy/medications?pageSize=100'), []);
  const docs = useAsync(() => get('/api/staff?kind=doctor&pageSize=50'), []);
  const upd = (i: number, k: string, v: string) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await post('/api/pharmacy/prescriptions', { patient_id: Number(patient), ...(user?.role !== 'doctor' && { doctor_id: Number(doctor) }), items: items.map((i) => ({ medication_id: Number(i.medication_id), quantity: Number(i.quantity), dosage: i.dosage })) });
      setItems([{ medication_id: '', quantity: '10', dosage: '' }]); onDone();
    } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="New prescription" wide>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Find patient" value={pq} onChange={(e) => setPq(e.target.value)} hint="Type at least 2 letters" />
          <SelectField label="Patient" required value={patient} onChange={(e) => setPatient(e.target.value)}><option value="">Select…</option>{(pats.data?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.last_name}, {p.first_name} ({p.mrn})</option>)}</SelectField>
          {user?.role !== 'doctor' && <SelectField label="Prescribing doctor" required value={doctor} onChange={(e) => setDoctor(e.target.value)}><option value="">Select…</option>{(docs.data?.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</SelectField>}
        </div>
        {items.map((it, i) => (
          <fieldset key={i} className="grid items-end gap-2 rounded-md border border-line p-2 sm:grid-cols-[2fr_6rem_2fr_auto]"><legend className="px-1 text-xs text-muted">Item {i + 1}</legend>
            <SelectField label="Medication" required value={it.medication_id} onChange={(e) => upd(i, 'medication_id', e.target.value)}><option value="">Select…</option>{(meds.data?.data ?? []).map((m: Med) => <option key={m.id} value={m.id}>{m.name} {m.strength}</option>)}</SelectField>
            <TextField label="Quantity" type="number" min={1} required value={it.quantity} onChange={(e) => upd(i, 'quantity', e.target.value)} />
            <TextField label="Dosage instructions" required value={it.dosage} onChange={(e) => upd(i, 'dosage', e.target.value)} />
            {items.length > 1 && <Button type="button" variant="ghost" aria-label={`Remove item ${i + 1}`} onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
          </fieldset>
        ))}
        <Button type="button" variant="secondary" onClick={() => setItems([...items, { medication_id: '', quantity: '10', dosage: '' }])}>Add item</Button>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create prescription</Button></div>
      </form>
    </Modal>
  );
}
