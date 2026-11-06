import { useState } from 'react';
import { Plus } from 'lucide-react';
import { get, post, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MedicationLookup, useLabMode } from '../components/vulnerable/LabTools';
import { PatientPicker } from '../components/PatientPicker';
import { PrescribeForm } from '../components/PrescribeForm';
import { Alert, Button, DataTable, Modal, PageHeader, SelectField, Spinner, StatusBadge, Tabs, Toolbar, errMsg, useAsync, useList, useToast, type Column } from '../components/ui';

interface Rx { id: number; status: string; dispensing_status: string; created_at: string; patient: string; mrn: string; doctor: string; item_count: number; refills_allowed: number; refills_used: number }
interface Med { id: number; code: string; name: string; form: string; strength: string; stock: number; drug_class?: string }

export default function Pharmacy() {
  const { can } = useAuth(); const toast = useToast();
  const urlQ = new URLSearchParams(window.location.search).get('q');
  const [tab, setTab] = useState(urlQ ? 'meds' : 'rx');
  const rx = useList<Rx>('/api/pharmacy/prescriptions');
  const meds = useList<Med>('/api/pharmacy/medications', '', 15, { urlQuery: true });
  const [detail, setDetail] = useState<number | null>(null);
  const [create, setCreate] = useState(false);
  const lab = useLabMode();
  const act = async (id: number, what: 'dispense' | 'refill') => {
    try { await post(`/api/pharmacy/prescriptions/${id}/${what}`); toast(what === 'dispense' ? 'Prescription dispensed' : 'Refill dispensed'); rx.reload(); meds.reload(); setDetail(null); } catch (x) { toast(errMsg(x), 'danger'); }
  };
  const rxCols: Column<Rx>[] = [
    { key: 'id', label: 'Rx', render: (r) => `RX-${String(r.id).padStart(4, '0')}` },
    { key: 'patient', label: 'Patient', render: (r) => <>{r.patient} <span className="text-muted">({r.mrn})</span></> },
    { key: 'doctor', label: 'Prescriber' },
    { key: 'item_count', label: 'Items' },
    { key: 'refills', label: 'Refills', render: (r) => (r.refills_allowed ? `${r.refills_allowed - r.refills_used} of ${r.refills_allowed} left` : '-') },
    { key: 'created_at', label: 'Issued', render: (r) => fmtDateTime(r.created_at) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'dispensing_status', label: 'Dispensing', render: (r) => <StatusBadge status={r.dispensing_status} /> },
  ];
  const medCols: Column<Med>[] = [
    { key: 'code', label: 'Code' }, { key: 'name', label: 'Medication' }, { key: 'form', label: 'Form' }, { key: 'strength', label: 'Strength' }, { key: 'drug_class', label: 'Class', render: (m) => m.drug_class || '-' },
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
      <Detail id={detail} onClose={() => setDetail(null)} onAct={(id, what) => void act(id, what)} canDispense={can('prescriptions.dispense')} canRefill={can('prescriptions.refill')} />
      <CreateDialog open={create} onClose={() => setCreate(false)} onDone={() => { setCreate(false); rx.reload(); toast('Prescription created'); }} />
    </div>
  );
}

function Detail({ id, onClose, onAct, canDispense, canRefill }: { id: number | null; onClose: () => void; onAct: (id: number, what: 'dispense' | 'refill') => void; canDispense: boolean; canRefill: boolean }) {
  const { data, loading, error } = useAsync(() => (id ? get(`/api/pharmacy/prescriptions/${id}`) : Promise.resolve(null)), [id]);
  const left = data ? data.refills_allowed - data.refills_used : 0;
  return (
    <Modal open={id !== null} onClose={onClose} title={id ? `Prescription RX-${String(id).padStart(4, '0')}` : ''} wide>
      {loading ? <Spinner /> : error ? <Alert>{error}</Alert> : data && (
        <div className="space-y-3">
          <p>{data.patient} ({data.mrn}) · prescribed by {data.doctor} · <StatusBadge status={data.dispensing_status} /></p>
          <table className="w-full text-left text-sm"><caption className="sr-only-live">Items</caption><thead className="text-xs uppercase text-muted"><tr><th className="py-1">Medication</th><th>Quantity</th><th>Dosage</th></tr></thead><tbody>{data.items.map((i: any) => <tr key={i.id} className="border-t border-line"><td className="py-1.5">{i.medication} {i.strength}</td><td>{i.quantity}</td><td>{i.dosage}{i.units_per_dose && i.doses_per_day ? <span className="block text-xs text-muted">{i.units_per_dose} unit(s) x {i.doses_per_day}/day</span> : null}</td></tr>)}</tbody></table>
          {data.refills_allowed > 0 && <p className="text-sm">Refills: <strong>{left}</strong> of {data.refills_allowed} remaining{data.last_dispensed_at && <span className="text-muted"> (last dispensed {fmtDateTime(data.last_dispensed_at)})</span>}</p>}
          {data.override_reason && <Alert tone="warn">Prescribed despite blocking safety findings. Documented reason: {data.override_reason}</Alert>}
          <p className="text-xs text-muted">{data.notice}</p>
          <div className="flex justify-end gap-2">
            {canDispense && data.status === 'Active' && data.dispensing_status !== 'Dispensed' && <Button onClick={() => onAct(data.id, 'dispense')}>Dispense</Button>}
            {canRefill && data.status === 'Active' && data.dispensing_status === 'Dispensed' && left > 0 && <Button onClick={() => onAct(data.id, 'refill')}>Dispense refill ({left} left)</Button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const [patient, setPatient] = useState(''); const [doctor, setDoctor] = useState('');
  const docs = useAsync(() => get('/api/staff?kind=doctor&pageSize=50'), []);
  return (
    <Modal open={open} onClose={onClose} title="New prescription" wide>
      <div className="space-y-3">
        <PatientPicker value={patient} onChange={setPatient} />
        {user?.role !== 'doctor' && <SelectField label="Prescribing doctor" required value={doctor} onChange={(e) => setDoctor(e.target.value)}><option value="">Select...</option>{(docs.data?.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</SelectField>}
        <PrescribeForm patientId={patient ? Number(patient) : null} submitLabel="Create prescription"
          onSubmit={(p) => post('/api/pharmacy/prescriptions', { patient_id: Number(patient), ...(user?.role !== 'doctor' && { doctor_id: Number(doctor) }), ...p })}
          onDone={() => onDone()} />
        <p className="text-xs text-muted">Allergies, interactions with current medicines and maximum daily doses are checked before anything is saved.</p>
      </div>
    </Modal>
  );
}

