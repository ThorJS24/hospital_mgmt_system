import { useState } from 'react';
import { Clock, HeartPulse, Plus, Siren, Users } from 'lucide-react';
import { get, patch, post, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLiveTick } from '../lib/live';
import { useT } from '../lib/i18n';
import { PatientPicker } from '../components/PatientPicker';
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SelectField, Spinner, StatCard, StatusBadge, Tabs, TextField, cx, errMsg, useAsync, useToast } from '../components/ui';

interface Entry {
  id: number; patient_id: number; patient: string; mrn: string; complaint: string; esi_level: number; status: string; arrived_at: string; started_at: string | null;
  completed_at: string | null; wait_minutes: number; doctor: string | null; heart_rate: number | null; systolic: number | null; spo2: number | null; notes: string;
}
const ESI: Record<number, { name: string; cls: string }> = {
  1: { name: 'Resuscitation', cls: 'bg-danger text-white' },
  2: { name: 'Emergent', cls: 'bg-danger/20 text-danger' },
  3: { name: 'Urgent', cls: 'bg-warn/20 text-warn' },
  4: { name: 'Less urgent', cls: 'bg-info/20 text-info' },
  5: { name: 'Non-urgent', cls: 'bg-ok/20 text-ok' },
};
const TARGET_MIN: Record<number, number> = { 1: 0, 2: 10, 3: 30, 4: 60, 5: 120 };

export const EsiBadge = ({ level }: { level: number }) => (
  <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold', ESI[level].cls)}><span aria-hidden>ESI {level}</span><span className="sr-only-live">Emergency severity {level}, </span><span className="hidden font-medium sm:inline">{ESI[level].name}</span></span>
);

export default function Triage() {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const tick = useLiveTick();
  const [tab, setTab] = useState('queue');
  const q = useAsync(() => get<{ data: Entry[]; stats: { waiting: number; inTreatment: number; longestWaitMinutes: number; byLevel: Record<string, number> } }>(`/api/triage${tab === 'history' ? '?status=all' : ''}`), [tab, tick]);
  const [register, setRegister] = useState(false);
  const [retriage, setRetriage] = useState<Entry | null>(null);
  const act = async (id: number, what: 'start' | 'complete' | 'leave', ok: string) => {
    try { await post(`/api/triage/${id}/${what}`); toast(ok); q.reload(); } catch (x) { toast(errMsg(x), 'danger'); }
  };
  const rows = (q.data?.data ?? []).filter((r) => (tab === 'queue' ? ['Waiting', 'In treatment'].includes(r.status) : true));
  const stats = q.data?.stats;
  const canTreat = can('triage.treat');
  const canTriage = can('triage.write');

  return (
    <div className="space-y-4">
      <PageHeader title={t('page.triage')} subtitle="Priority-ordered by Emergency Severity Index, then arrival time" actions={canTriage ? <Button onClick={() => setRegister(true)}><Plus className="h-4 w-4" />Register arrival</Button> : undefined} />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Waiting" value={stats?.waiting ?? '-'} icon={Users} tone={stats && stats.waiting > 5 ? 'warn' : 'primary'} sub={stats ? Object.entries(stats.byLevel).map(([l, n]) => `ESI ${l}: ${n}`).join(' | ') || 'Nobody waiting' : undefined} />
        <StatCard label="In treatment" value={stats?.inTreatment ?? '-'} icon={HeartPulse} tone="info" />
        <StatCard label="Longest wait" value={stats ? `${stats.longestWaitMinutes} min` : '-'} icon={Clock} tone={stats && stats.longestWaitMinutes > 60 ? 'danger' : 'ok'} />
      </div>
      <Card>
        <Tabs tabs={[{ id: 'queue', label: 'Active queue' }, { id: 'history', label: 'Last 3 days' }]} value={tab} onChange={setTab} />
        <div className="mt-3">
          {q.error ? <Alert>{q.error}</Alert> : q.loading && !q.data ? <Spinner /> : !rows.length ? <EmptyState title="The queue is empty" hint="New arrivals appear here as soon as they are triaged." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only-live">Emergency triage queue</caption>
                <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-2">Acuity</th><th>Patient</th><th>Complaint</th><th>Wait</th><th>Status</th><th><span className="sr-only-live">Actions</span></th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const overdue = r.status === 'Waiting' && r.wait_minutes > TARGET_MIN[r.esi_level];
                    return (
                      <tr key={r.id} className={cx('border-t border-line', r.esi_level === 1 && r.status === 'Waiting' && 'bg-danger/5')}>
                        <td className="px-2 py-2"><EsiBadge level={r.esi_level} /></td>
                        <td>{r.patient} <span className="text-muted">({r.mrn})</span></td>
                        <td className="max-w-xs">{r.complaint}{(r.heart_rate || r.systolic || r.spo2) && <span className="block text-xs text-muted">{[r.heart_rate && `HR ${r.heart_rate}`, r.systolic && `SBP ${r.systolic}`, r.spo2 && `SpO2 ${r.spo2}%`].filter(Boolean).join(' | ')}</span>}</td>
                        <td className={cx('whitespace-nowrap tabular-nums', overdue && 'font-semibold text-danger')}>{r.wait_minutes} min{overdue && <span className="ml-1 text-xs">(over {TARGET_MIN[r.esi_level]} min target)</span>}<span className="block text-xs font-normal text-muted">{fmtDateTime(r.arrived_at)}</span></td>
                        <td><StatusBadge status={r.status} tone={r.status === 'Waiting' ? 'warn' : r.status === 'In treatment' ? 'info' : r.status === 'Completed' ? 'ok' : 'neutral'} />{r.doctor && <span className="block text-xs text-muted">{r.doctor}</span>}</td>
                        <td className="text-right">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            {r.status === 'Waiting' && canTreat && <Button onClick={() => void act(r.id, 'start', 'Treatment started')}>Start treatment</Button>}
                            {r.status === 'In treatment' && canTreat && <Button variant="secondary" onClick={() => void act(r.id, 'complete', 'Visit completed')}>Complete</Button>}
                            {r.status === 'Waiting' && canTriage && <Button variant="secondary" onClick={() => setRetriage(r)}>Re-triage</Button>}
                            {r.status === 'Waiting' && canTriage && <Button variant="ghost" onClick={() => void act(r.id, 'leave', 'Marked as left without being seen')}>Left</Button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
      <p className="flex items-center gap-1.5 text-xs text-muted"><Siren className="h-3.5 w-3.5" aria-hidden />ESI 1 arrivals alert every doctor, nurse and administrator immediately.</p>
      <RegisterDialog open={register} onClose={() => setRegister(false)} onDone={() => { setRegister(false); toast('Arrival registered'); q.reload(); }} />
      <RetriageDialog entry={retriage} onClose={() => setRetriage(null)} onDone={() => { setRetriage(null); toast('Acuity updated'); q.reload(); }} />
    </div>
  );
}

function RegisterDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ patient_id: '', complaint: '', esi_level: '3', heart_rate: '', systolic: '', spo2: '', notes: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await post('/api/triage', {
        patient_id: Number(f.patient_id), complaint: f.complaint.trim(), esi_level: Number(f.esi_level), notes: f.notes,
        ...(f.heart_rate && { heart_rate: Number(f.heart_rate) }), ...(f.systolic && { systolic: Number(f.systolic) }), ...(f.spo2 && { spo2: Number(f.spo2) }),
      });
      setF({ patient_id: '', complaint: '', esi_level: '3', heart_rate: '', systolic: '', spo2: '', notes: '' });
      onDone();
    } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Register emergency arrival" wide>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <PatientPicker value={f.patient_id} onChange={(id) => setF({ ...f, patient_id: id })} />
        <TextField label="Presenting complaint" required maxLength={200} value={f.complaint} onChange={set('complaint')} />
        <SelectField label="Emergency Severity Index" required value={f.esi_level} onChange={set('esi_level')}>{[1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>{l} - {ESI[l].name}</option>)}</SelectField>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="Heart rate (bpm)" type="number" min={20} max={250} value={f.heart_rate} onChange={set('heart_rate')} />
          <TextField label="Systolic BP (mmHg)" type="number" min={40} max={300} value={f.systolic} onChange={set('systolic')} />
          <TextField label="SpO2 (%)" type="number" min={50} max={100} value={f.spo2} onChange={set('spo2')} />
        </div>
        <TextField label="Triage notes" maxLength={300} value={f.notes} onChange={set('notes')} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={!f.patient_id || f.complaint.trim().length < 2}>Add to queue</Button></div>
      </form>
    </Modal>
  );
}

function RetriageDialog({ entry, onClose, onDone }: { entry: Entry | null; onClose: () => void; onDone: () => void }) {
  const [level, setLevel] = useState('3'); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<number | null>(null);
  if (entry && seen !== entry.id) { setSeen(entry.id); setLevel(String(entry.esi_level)); setErr(''); }
  const save = async () => {
    if (!entry) return;
    setBusy(true); setErr('');
    try { await patch(`/api/triage/${entry.id}`, { esi_level: Number(level) }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!entry} onClose={onClose} title="Re-triage patient">
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <p className="text-sm">{entry?.patient} - {entry?.complaint}</p>
        <SelectField label="New acuity" value={level} onChange={(e) => setLevel(e.target.value)}>{[1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>{l} - {ESI[l].name}</option>)}</SelectField>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}
