import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, FlaskConical, Lock, Pill, Plus, Search, Stethoscope, X } from 'lucide-react';
import { get, patch, post, put, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PrescribeForm, RxWarnings, type RxWarning } from '../components/PrescribeForm';
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SelectField, Spinner, StatusBadge, TextArea, TextField, cx, errMsg, useAsync, useToast } from '../components/ui';

interface Dx { code: string; description: string; is_primary: boolean }
const SOAP = [
  ['subjective', 'Subjective', 'What the patient reports: history, symptoms, concerns'],
  ['objective', 'Objective', 'Examination findings, vital signs, results reviewed'],
  ['assessment', 'Assessment', 'Clinical impression and reasoning'],
  ['plan', 'Plan', 'Treatment, orders, follow-up and advice'],
] as const;
type SoapKey = (typeof SOAP)[number][0];
const SEVERITY_TONE = { Mild: 'info', Moderate: 'warn', Severe: 'danger' } as const;

export default function Consultation() {
  const { id } = useParams();
  const { user, can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync(() => get(`/api/consultations/${id}`), [id]);
  const [soap, setSoap] = useState<Record<SoapKey, string>>({ subjective: '', objective: '', assessment: '', plan: '' });
  const [saved, setSaved] = useState<Record<SoapKey, string>>({ subjective: '', objective: '', assessment: '', plan: '' });
  const [dx, setDx] = useState<Dx[]>([]);
  const [dxDirty, setDxDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    if (!data) return;
    const s = { subjective: data.subjective, objective: data.objective, assessment: data.assessment, plan: data.plan };
    setSoap(s); setSaved(s);
    setDx(data.diagnoses.map((d: any) => ({ code: d.code, description: d.description, is_primary: d.is_primary })));
    setDxDirty(false);
  }, [data]);

  const editable = !!data && data.status === 'Draft' && can('consultations.write') && data.doctor_id === user?.staffId;
  const dirty = (Object.keys(soap) as SoapKey[]).filter((k) => soap[k] !== saved[k]);

  const saveSoap = async () => {
    if (!dirty.length) return true;
    setBusy('soap'); setErr('');
    try {
      await patch(`/api/consultations/${id}`, Object.fromEntries(dirty.map((k) => [k, soap[k]])));
      setSaved({ ...soap });
      return true;
    } catch (x) { setErr(errMsg(x)); return false; } finally { setBusy(''); }
  };
  const saveDx = async () => {
    if (!dxDirty) return true;
    setBusy('dx'); setErr('');
    try { await put(`/api/consultations/${id}/diagnoses`, { diagnoses: dx.map((d) => ({ icd_code: d.code, is_primary: d.is_primary })) }); setDxDirty(false); return true; }
    catch (x) { setErr(errMsg(x)); return false; } finally { setBusy(''); }
  };
  const sign = async () => {
    setBusy('sign'); setErr('');
    try {
      if (!(await saveSoap()) || !(await saveDx())) return;
      await post(`/api/consultations/${id}/sign`);
      toast('Consultation signed and locked');
      setSigning(false);
      reload();
    } catch (x) { setErr(errMsg(x)); setSigning(false); } finally { setBusy(''); }
  };

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert>{error ?? 'Consultation not found'}</Alert>;
  const primary = dx.find((d) => d.is_primary);
  const canSign = editable && soap.assessment.trim().length > 0 && !!primary;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Consultation" subtitle={`${data.patient} (${data.mrn}) - ${data.doctor} - started ${fmtDateTime(data.created_at)}`}
        actions={<>
          <Link to={`/patients/${data.patient_id}`} className="inline-flex items-center rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface2">Patient record</Link>
          <Button variant="secondary" onClick={() => navigate('/consultations')}>All consultations</Button>
        </>}
        leading={<span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary"><Stethoscope className="h-6 w-6" aria-hidden /></span>}
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={data.status} tone={data.status === 'Signed' ? 'ok' : 'warn'} />
        {data.status === 'Signed' && <span className="inline-flex items-center gap-1 text-xs text-muted"><Lock className="h-3 w-3" aria-hidden />Signed {fmtDateTime(data.signed_at)}. Further changes are not possible.</span>}
        {data.status === 'Draft' && !editable && <span className="text-xs text-muted">Read-only: only the authoring doctor can edit this draft.</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Allergies:</span>
          {data.allergies.length ? data.allergies.map((a: any) => <StatusBadge key={a.allergen} status={`${a.allergen} (${a.severity})`} tone={SEVERITY_TONE[a.severity as keyof typeof SEVERITY_TONE]} />) : <span className="text-muted">none recorded</span>}
        </span>
      </div>
      {err && <Alert>{err}</Alert>}

      <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
        <div className="space-y-4">
          <Card title="SOAP note" actions={editable && <Button variant="secondary" loading={busy === 'soap'} disabled={!dirty.length} onClick={() => void saveSoap().then((ok) => ok && toast('Note saved'))}>Save note</Button>}>
            <div className="space-y-3">
              {SOAP.map(([k, label, hint]) => editable
                ? <TextArea key={k} label={label} hint={hint} rows={k === 'assessment' || k === 'plan' ? 3 : 4} maxLength={4000} value={soap[k]} onChange={(e) => setSoap({ ...soap, [k]: e.target.value })} onBlur={() => void saveSoap()} />
                : <div key={k}><h3 className="text-xs font-medium text-muted">{label}</h3><p className="mt-0.5 whitespace-pre-wrap text-sm">{soap[k] || <span className="text-muted">Not recorded</span>}</p></div>)}
            </div>
            {editable && dirty.length > 0 && <p className="mt-2 text-xs text-warn">Unsaved changes: {dirty.join(', ')} (saved automatically when you leave a field)</p>}
          </Card>
          <Orders id={String(id)} data={data} editable={editable} patientId={data.patient_id} onChanged={reload} />
        </div>

        <div className="space-y-4">
          <Card title="Diagnoses (ICD-10)" actions={editable && <Button variant="secondary" loading={busy === 'dx'} disabled={!dxDirty} onClick={() => void saveDx().then((ok) => ok && toast('Diagnoses saved'))}>Save diagnoses</Button>}>
            <DiagnosisEditor dx={dx} editable={editable} onChange={(next) => { setDx(next); setDxDirty(true); }} />
          </Card>
          <Card title="Sign-off">
            {data.status === 'Signed' ? (
              <p className="flex items-center gap-2 text-sm text-ok"><CheckCircle2 className="h-4 w-4" aria-hidden />Signed by {data.doctor}</p>
            ) : (
              <div className="space-y-2 text-sm">
                <ul className="space-y-1">
                  <Check ok={soap.assessment.trim().length > 0}>Assessment recorded</Check>
                  <Check ok={!!primary}>Primary diagnosis selected</Check>
                </ul>
                <p className="text-xs text-muted">Signing locks the note, links the primary diagnosis to the problem list and completes the appointment.</p>
                <Button disabled={!canSign} loading={busy === 'sign'} onClick={() => setSigning(true)}>Sign and lock</Button>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Modal open={signing} onClose={() => setSigning(false)} title="Sign this consultation?">
        <div className="space-y-3 text-sm">
          <p>You are about to sign the consultation for <strong>{data.patient}</strong>. After signing it can no longer be edited, and its orders and prescriptions are final.</p>
          <p className="rounded-md bg-surface2 p-2">Primary diagnosis: <strong>{primary ? `${primary.description} (${primary.code})` : 'none'}</strong></p>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setSigning(false)}>Review again</Button><Button loading={busy === 'sign'} onClick={sign}>Sign consultation</Button></div>
        </div>
      </Modal>
    </div>
  );
}

const Check = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li className={cx('flex items-center gap-2', ok ? 'text-ok' : 'text-muted')}>{ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}{children}<span className="sr-only-live">{ok ? ' done' : ' pending'}</span></li>
);

function DiagnosisEditor({ dx, editable, onChange }: { dx: Dx[]; editable: boolean; onChange: (next: Dx[]) => void }) {
  const [q, setQ] = useState('');
  const results = useAsync(() => (q.trim().length >= 2 ? get<{ data: { code: string; description: string }[] }>(`/api/icd10?q=${encodeURIComponent(q.trim())}`) : Promise.resolve({ data: [] })), [q]);
  const available = useMemo(() => (results.data?.data ?? []).filter((r) => !dx.some((d) => d.code === r.code)), [results.data, dx]);
  const add = (r: { code: string; description: string }) => { onChange([...dx, { ...r, is_primary: dx.length === 0 }]); setQ(''); };
  const remove = (code: string) => { const rest = dx.filter((d) => d.code !== code); if (rest.length && !rest.some((d) => d.is_primary)) rest[0].is_primary = true; onChange([...rest]); };
  return (
    <div className="space-y-3">
      {!dx.length ? <EmptyState title="No diagnoses yet" hint={editable ? 'Search the ICD-10 list below.' : undefined} /> : (
        <ul className="space-y-1.5">
          {dx.map((d) => (
            <li key={d.code} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm">
              <input type="radio" name="primary-dx" checked={d.is_primary} disabled={!editable} onChange={() => onChange(dx.map((x) => ({ ...x, is_primary: x.code === d.code })))} aria-label={`Primary diagnosis: ${d.code}`} />
              <span className="min-w-0 flex-1"><strong className="mr-1.5 font-mono text-xs">{d.code}</strong>{d.description}{d.is_primary && <span className="ml-2 text-xs text-primary">primary</span>}</span>
              {editable && <button className="rounded p-1 text-muted hover:bg-surface2 hover:text-danger" aria-label={`Remove ${d.code}`} onClick={() => remove(d.code)}><X className="h-3.5 w-3.5" /></button>}
            </li>
          ))}
        </ul>
      )}
      {editable && dx.length < 10 && (
        <div>
          <TextField label="Add diagnosis" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code or name, e.g. I10 or asthma" hint="Type at least 2 characters" />
          {q.trim().length >= 2 && (
            <ul className="mt-1.5 max-h-48 overflow-y-auto rounded-md border border-line" aria-label="ICD-10 matches">
              {results.loading ? <li className="px-3 py-2 text-xs text-muted"><Search className="mr-1 inline h-3 w-3" aria-hidden />Searching...</li>
                : !available.length ? <li className="px-3 py-2 text-xs text-muted">No matching codes</li>
                : available.map((r) => <li key={r.code}><button type="button" onClick={() => add(r)} className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface2"><Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden /><span><strong className="mr-1.5 font-mono text-xs">{r.code}</strong>{r.description}</span></button></li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Orders({ id, data, editable, patientId, onChanged }: { id: string; data: any; editable: boolean; patientId: number; onChanged: () => void }) {
  const toast = useToast();
  const tests = useAsync(() => (editable ? get<{ data: { id: number; code: string; name: string }[] }>('/api/laboratory/tests') : Promise.resolve({ data: [] })), [editable]);
  const [testId, setTestId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastWarnings, setLastWarnings] = useState<RxWarning[]>([]);
  const order = async () => {
    setBusy(true); setErr('');
    try { await post(`/api/consultations/${id}/lab-orders`, { test_ids: [Number(testId)] }); setTestId(''); toast('Laboratory test ordered'); onChanged(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Card title="Orders">
      {err && <div className="mb-2"><Alert>{err}</Alert></div>}
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><FlaskConical className="h-3.5 w-3.5" aria-hidden />Laboratory</h3>
      {data.lab_orders.length ? <ul className="mb-2 space-y-1 text-sm">{data.lab_orders.map((l: any) => <li key={l.id} className="flex items-center justify-between rounded-md border border-line px-2.5 py-1.5"><span>{l.test} <span className="text-muted">({l.code})</span></span><StatusBadge status={l.status} /></li>)}</ul> : <p className="mb-2 text-sm text-muted">No laboratory tests ordered.</p>}
      {editable && (
        <div className="mb-4 flex items-end gap-2">
          <div className="flex-1"><SelectField label="Order a test" value={testId} onChange={(e) => setTestId(e.target.value)}><option value="">Select...</option>{(tests.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}</SelectField></div>
          <Button variant="secondary" disabled={!testId} loading={busy} onClick={order}>Order</Button>
        </div>
      )}
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><Pill className="h-3.5 w-3.5" aria-hidden />Prescriptions</h3>
      {data.prescriptions.length ? <ul className="mb-2 space-y-1 text-sm">{data.prescriptions.map((r: any) => <li key={r.id} className="rounded-md border border-line px-2.5 py-1.5"><div className="flex items-center justify-between"><span className="font-medium">RX-{String(r.id).padStart(4, '0')}</span><StatusBadge status={r.status} /></div><p className="text-muted">{r.summary}</p>{r.refills_allowed > 0 && <p className="text-xs text-muted">{r.refills_allowed} refill(s) allowed</p>}{r.override_reason && <p className="text-xs text-warn">Safety override: {r.override_reason}</p>}</li>)}</ul> : <p className="mb-2 text-sm text-muted">No prescriptions issued.</p>}
      {lastWarnings.length > 0 && <div className="mb-2"><RxWarnings warnings={lastWarnings} /></div>}
      {editable && (
        <details className="rounded-md border border-line p-2">
          <summary className="cursor-pointer text-sm font-medium">New prescription</summary>
          <div className="mt-3">
            <PrescribeForm patientId={patientId}
              onSubmit={(p) => post(`/api/consultations/${id}/prescriptions`, p)}
              onDone={(w) => { setLastWarnings(w); toast('Prescription issued'); onChanged(); }} />
          </div>
        </details>
      )}
    </Card>
  );
}
