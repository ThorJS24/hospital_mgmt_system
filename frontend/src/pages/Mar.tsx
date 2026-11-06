import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Plus, ShieldAlert } from 'lucide-react';
import { get, post, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLiveTick } from '../lib/live';
import { useT } from '../lib/i18n';
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SelectField, Spinner, StatCard, StatusBadge, TextField, cx, errMsg, useAsync, useToast } from '../components/ui';

interface Dose {
  id: number; admission_id: number; scheduled_at: string; status: 'Scheduled' | 'Given' | 'Held' | 'Refused' | 'Missed'; administered_at: string | null; note: string;
  patient: string; mrn: string; ward: string; bed: string; medication: string; strength: string; dosage: string; administered_by: string | null; severe_allergies: number; overdue: boolean; patient_id: number;
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hhmm = (s: string) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function Mar() {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const tick = useLiveTick();
  const [date, setDate] = useState(today());
  const [onlyOpen, setOnlyOpen] = useState(false);
  const mar = useAsync(() => get<{ date: string; data: Dose[]; counts: Record<string, number>; overdue: number }>(`/api/mar?date=${date}`), [date, tick]);
  const [target, setTarget] = useState<{ dose: Dose; status: 'Held' | 'Refused' | 'Missed' } | null>(null);
  const [schedule, setSchedule] = useState(false);
  const administer = can('mar.administer');

  const give = async (d: Dose) => { try { await post(`/api/mar/${d.id}/administer`, { status: 'Given' }); toast(`${d.medication} recorded as given`); mar.reload(); } catch (x) { toast(errMsg(x), 'danger'); } };

  const grouped = useMemo(() => {
    const rows = (mar.data?.data ?? []).filter((d) => !onlyOpen || d.status === 'Scheduled');
    const map = new Map<number, { key: number; patient: string; mrn: string; ward: string; bed: string; severe: number; doses: Dose[] }>();
    for (const d of rows) {
      if (!map.has(d.admission_id)) map.set(d.admission_id, { key: d.admission_id, patient: d.patient, mrn: d.mrn, ward: d.ward, bed: d.bed, severe: d.severe_allergies, doses: [] });
      map.get(d.admission_id)!.doses.push(d);
    }
    return [...map.values()].sort((a, b) => a.ward.localeCompare(b.ward) || a.bed.localeCompare(b.bed));
  }, [mar.data, onlyOpen]);

  const c = mar.data?.counts;
  return (
    <div className="space-y-4">
      <PageHeader title={t('page.mar')} subtitle="Scheduled doses for current inpatients, with a timestamped record of each one given"
        actions={can('mar.schedule') ? <Button onClick={() => setSchedule(true)}><Plus className="h-4 w-4" />Schedule doses</Button> : undefined} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Due or upcoming" value={c?.Scheduled ?? '-'} icon={Clock} tone="info" />
        <StatCard label="Overdue (over 1 h)" value={mar.data?.overdue ?? '-'} icon={AlertTriangle} tone={mar.data?.overdue ? 'danger' : 'ok'} />
        <StatCard label="Given" value={c?.Given ?? '-'} icon={CheckCircle2} tone="ok" />
        <StatCard label="Held, refused or missed" value={c ? c.Held + c.Refused + c.Missed : '-'} icon={ShieldAlert} tone="warn" />
      </div>
      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <TextField label="Date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />Only doses still to give</label>
          <Button variant="secondary" onClick={() => setDate(today())}>Today</Button>
        </div>
        {mar.error ? <Alert>{mar.error}</Alert> : mar.loading && !mar.data ? <Spinner /> : !grouped.length ? <EmptyState title="No doses for this day" hint="Doctors schedule doses for an inpatient's active prescription." /> : (
          <div className="space-y-4">
            {grouped.map((g) => (
              <section key={g.key} aria-label={`${g.patient}, ${g.ward} bed ${g.bed}`} className="rounded-lg border border-line">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface2/50 px-3 py-2 text-sm">
                  <span><strong>{g.patient}</strong> <span className="text-muted">({g.mrn})</span></span>
                  <span className="flex items-center gap-2 text-muted">{g.ward} - bed {g.bed}{g.severe > 0 && <StatusBadge status="Severe allergy on file" tone="danger" />}</span>
                </header>
                <ul>
                  {g.doses.map((d) => (
                    <li key={d.id} className={cx('flex flex-wrap items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-0', d.overdue && 'bg-danger/5')}>
                      <span className="w-16 font-mono tabular-nums">{hhmm(d.scheduled_at)}</span>
                      <span className="min-w-0 flex-1"><strong>{d.medication}</strong> {d.strength}<span className="block text-xs text-muted">{d.dosage}</span></span>
                      <span className="text-right text-xs text-muted">
                        {d.status !== 'Scheduled' && d.administered_at && <>{d.status} {hhmm(d.administered_at)}{d.administered_by ? ` by ${d.administered_by}` : ''}{d.note && <span className="block">Note: {d.note}</span>}</>}
                        {d.overdue && <span className="font-semibold text-danger">Overdue</span>}
                      </span>
                      <StatusBadge status={d.status} tone={d.status === 'Given' ? 'ok' : d.status === 'Scheduled' ? (d.overdue ? 'danger' : 'info') : 'warn'} />
                      {administer && d.status === 'Scheduled' && (
                        <span className="flex gap-1.5">
                          <Button onClick={() => void give(d)}>Give</Button>
                          <Button variant="secondary" onClick={() => setTarget({ dose: d, status: 'Held' })}>Hold</Button>
                          <Button variant="ghost" onClick={() => setTarget({ dose: d, status: 'Refused' })}>Refused</Button>
                          {d.overdue && <Button variant="ghost" onClick={() => setTarget({ dose: d, status: 'Missed' })}>Missed</Button>}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>
      <ReasonDialog target={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); toast('Dose recorded'); mar.reload(); }} />
      <ScheduleDialog open={schedule} onClose={() => setSchedule(false)} onDone={(n) => { setSchedule(false); toast(`${n} dose${n === 1 ? '' : 's'} scheduled`); mar.reload(); }} />
    </div>
  );
}

function ReasonDialog({ target, onClose, onDone }: { target: { dose: Dose; status: 'Held' | 'Refused' | 'Missed' } | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!target) return;
    setBusy(true); setErr('');
    try { await post(`/api/mar/${target.dose.id}/administer`, { status: target.status, note: note.trim() }); setNote(''); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!target} onClose={onClose} title={target ? `${target.status}: ${target.dose.medication}` : ''}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <p className="text-sm">{target?.dose.patient} - scheduled {target ? fmtDateTime(target.dose.scheduled_at) : ''}</p>
        <TextField label="Reason" required maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} hint="Required whenever a dose is not given" autoFocus />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={note.trim().length < 3}>Record</Button></div>
      </form>
    </Modal>
  );
}

const COMMON_TIMES = ['06:00', '08:00', '12:00', '14:00', '18:00', '20:00', '22:00'];

function ScheduleDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (n: number) => void }) {
  const [admission, setAdmission] = useState(''); const [item, setItem] = useState('');
  const [times, setTimes] = useState<string[]>(['08:00', '20:00']); const [days, setDays] = useState('1'); const [start, setStart] = useState(today());
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const adms = useAsync(() => (open ? get<{ data: { id: number; patient_id: number; patient: string; mrn: string; ward: string; bed: string }[] }>('/api/admissions?status=Admitted') : Promise.resolve({ data: [] })), [open]);
  const patientId = adms.data?.data.find((a) => String(a.id) === admission)?.patient_id;
  const items = useAsync(async () => {
    if (!patientId) return [] as { id: number; label: string }[];
    const list = await get<{ data: { id: number; status: string }[] }>(`/api/pharmacy/prescriptions?patient_id=${patientId}&pageSize=10`);
    const active = list.data.filter((r) => r.status === 'Active');
    const details = await Promise.all(active.map((r) => get(`/api/pharmacy/prescriptions/${r.id}`)));
    return details.flatMap((d: any) => d.items.map((i: any) => ({ id: i.id as number, label: `RX-${String(d.id).padStart(4, '0')}: ${i.medication} ${i.strength} - ${i.dosage}` })));
  }, [patientId]);
  const toggle = (tm: string) => setTimes(times.includes(tm) ? times.filter((x) => x !== tm) : [...times, tm].sort());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await post('/api/mar/schedule', { admission_id: Number(admission), prescription_item_id: Number(item), times, days: Number(days), start_date: start }); onDone(r.created); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Schedule doses" wide>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <SelectField label="Inpatient" required value={admission} onChange={(e) => { setAdmission(e.target.value); setItem(''); }}>
          <option value="">Select...</option>{(adms.data?.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.patient} ({a.mrn}) - {a.ward} {a.bed}</option>)}
        </SelectField>
        <SelectField label="Medication from an active prescription" required value={item} onChange={(e) => setItem(e.target.value)} hint={admission && !items.loading && !(items.data ?? []).length ? 'This patient has no active prescription. Prescribe first.' : undefined}>
          <option value="">Select...</option>{(items.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </SelectField>
        <fieldset><legend className="mb-1 text-xs font-medium text-muted">Administration times</legend>
          <div className="flex flex-wrap gap-2">{COMMON_TIMES.map((tm) => <label key={tm} className={cx('cursor-pointer rounded-lg border px-2.5 py-1 text-sm', times.includes(tm) ? 'border-primary bg-primary/10 text-primary' : 'border-line')}><input type="checkbox" className="sr-only-live" checked={times.includes(tm)} onChange={() => toggle(tm)} />{tm}</label>)}</div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Start date" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="Number of days" type="number" min={1} max={14} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={!admission || !item || !times.length}>Schedule</Button></div>
      </form>
    </Modal>
  );
}
