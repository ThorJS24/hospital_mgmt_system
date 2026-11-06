import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { post, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { PatientPicker } from '../components/PatientPicker';
import { Alert, Button, Card, DataTable, Modal, PageHeader, SelectField, StatusBadge, Toolbar, errMsg, useList, type Column } from '../components/ui';

interface Row { id: number; patient: string; mrn: string; doctor: string; status: string; primary_diagnosis: string | null; created_at: string; signed_at: string | null }

export default function Consultations() {
  const { can } = useAuth();
  const { t } = useT();
  const navigate = useNavigate();
  const list = useList<Row>('/api/consultations');
  const [open, setOpen] = useState(false);
  const cols: Column<Row>[] = [
    { key: 'patient', label: 'Patient', render: (r) => <>{r.patient} <span className="text-muted">({r.mrn})</span></> },
    { key: 'doctor', label: 'Doctor' },
    { key: 'primary_diagnosis', label: 'Primary diagnosis', render: (r) => r.primary_diagnosis ?? <span className="text-muted">Not set</span> },
    { key: 'created_at', label: 'Started', render: (r) => fmtDateTime(r.created_at) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} tone={r.status === 'Signed' ? 'ok' : 'warn'} /> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('page.consultations')} subtitle="SOAP notes, ICD-10 diagnoses, orders and sign-off" actions={can('consultations.write') ? <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New consultation</Button> : undefined} />
      <Card>
        <Toolbar list={list} placeholder="Patient or MRN">
          <SelectField label="Status" value={list.state.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}><option value="">All</option><option>Draft</option><option>Signed</option></SelectField>
          {can('consultations.write') && <SelectField label="Show" value={list.state.filters.mine ?? ''} onChange={(e) => list.setFilter('mine', e.target.value)}><option value="">Care team</option><option value="1">Only mine</option></SelectField>}
        </Toolbar>
        <DataTable list={list} columns={cols} caption="Consultations" onRowClick={(r) => navigate(`/consultations/${r.id}`)} empty="No consultations yet" />
      </Card>
      <StartDialog open={open} onClose={() => setOpen(false)} onStarted={(id) => navigate(`/consultations/${id}`)} />
    </div>
  );
}

function StartDialog({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: (id: number) => void }) {
  const [patient, setPatient] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setErr('');
    try { const r = await post('/api/consultations', { patient_id: Number(patient) }); onClose(); onStarted(r.id); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Start a consultation">
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <PatientPicker value={patient} onChange={setPatient} />
        <p className="text-xs text-muted">To consult against a booked visit, start from the Appointments page instead: the appointment moves through the clinic flow automatically.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!patient} onClick={start}>Start</Button></div>
      </div>
    </Modal>
  );
}
