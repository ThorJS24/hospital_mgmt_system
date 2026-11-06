import { useMemo, useState } from 'react';
import { CalendarCheck2, CalendarPlus, Download, FileText, FlaskConical, Pill, Wallet } from 'lucide-react';
import { get, patch, post, fmtDate, fmtDateTime, money } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Alert, Button, Card, EmptyState, KV, Modal, PageHeader, SelectField, Spinner, StatCard, StatusBadge, Tabs, TextField, cx, errMsg, useAsync, useToast } from '../components/ui';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
interface Doctor { id: number; full_name: string; job_title: string; department: string }
const FLAG_TONE = { normal: 'ok', low: 'warn', high: 'warn' } as const;

export default function Portal() {
  const { t } = useT();
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const me = useAsync(() => get('/api/portal/me'), []);
  const [book, setBook] = useState(false);
  const tabs = [
    { id: 'overview', label: t('portal.overview') }, { id: 'appointments', label: t('portal.appointments') }, { id: 'results', label: t('portal.results') },
    { id: 'bills', label: t('portal.bills') }, { id: 'medicines', label: t('portal.medicines') }, { id: 'details', label: t('portal.details') },
  ];
  if (me.loading && !me.data) return <Spinner />;
  if (me.error || !me.data) return <Alert>{me.error ?? 'Could not load your record'}</Alert>;
  const p = me.data.patient;
  const next = me.data.nextAppointment;
  return (
    <div className="space-y-4">
      <PageHeader image="/img/hospital/h1.jpg" title={`${t('page.portal')}: ${p.first_name} ${p.last_name}`} subtitle={`Medical record number ${p.mrn}`} actions={<Button onClick={() => setBook(true)}><CalendarPlus className="h-4 w-4" />{t('portal.book')}</Button>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard label={t('portal.nextAppointment')} value={next ? fmtDate(next.scheduled_at) : 'None booked'} icon={CalendarCheck2} tone="info" sub={next ? `${new Date(next.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} with ${next.doctor} (${next.department})` : 'Book one in a few clicks'} />
            <StatCard label={t('portal.balanceDue')} value={money(me.data.balanceDue)} icon={Wallet} tone={me.data.balanceDue > 0 ? 'warn' : 'ok'} sub={me.data.balanceDue > 0 ? 'See the Bills tab' : 'You are all paid up'} />
          </div>
          <Card title="Allergies on file">
            {me.data.allergies.length ? <ul className="flex flex-wrap gap-2">{me.data.allergies.map((a: any) => <li key={a.allergen}><StatusBadge status={`${a.allergen}${a.reaction ? `: ${a.reaction}` : ''}`} tone={a.severity === 'Severe' ? 'danger' : a.severity === 'Moderate' ? 'warn' : 'info'} /></li>)}</ul> : <p className="text-sm text-muted">None recorded. Tell your care team if this is out of date.</p>}
          </Card>
          <Alert tone="info">This portal shows synthetic records for a fictional hospital. Test results are released only after a clinician approves them.</Alert>
        </div>
      )}
      {tab === 'appointments' && <Appointments onBook={() => setBook(true)} refreshKey={book} onChanged={me.reload} />}
      {tab === 'results' && <Results />}
      {tab === 'bills' && <Bills />}
      {tab === 'medicines' && <Medicines />}
      {tab === 'details' && <Details p={p} onSaved={me.reload} email={user?.email ?? ''} />}
      <BookDialog open={book} onClose={() => setBook(false)} onDone={() => { setBook(false); me.reload(); setTab('appointments'); }} />
    </div>
  );
}

function Appointments({ onBook, refreshKey, onChanged }: { onBook: () => void; refreshKey: boolean; onChanged: () => void }) {
  const toast = useToast();
  const list = useAsync(() => get<{ data: any[] }>('/api/portal/appointments'), [refreshKey]);
  const [cancel, setCancel] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const doCancel = async () => {
    setBusy(true);
    try { await post(`/api/portal/appointments/${cancel.id}/cancel`); toast('Appointment cancelled'); setCancel(null); list.reload(); onChanged(); } catch (x) { toast(errMsg(x), 'danger'); setCancel(null); }
    setBusy(false);
  };
  const rows = list.data?.data ?? [];
  const now = Date.now();
  return (
    <Card title="Your appointments" actions={<Button onClick={onBook}><CalendarPlus className="h-4 w-4" />Book</Button>}>
      {list.error ? <Alert>{list.error}</Alert> : list.loading && !list.data ? <Spinner /> : !rows.length ? <EmptyState title="No appointments yet" action={<Button onClick={onBook}>Book your first appointment</Button>} /> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only-live">Your appointments</caption>
          <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-2">When</th><th>Doctor</th><th>Department</th><th>Reason</th><th>Status</th><th><span className="sr-only-live">Actions</span></th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id} className="border-t border-line"><td className="px-2 py-2 whitespace-nowrap">{fmtDateTime(a.scheduled_at)}</td><td>{a.doctor}</td><td>{a.department}</td><td>{a.reason || '-'}</td><td><StatusBadge status={a.status} /></td>
              <td className="text-right">{['Scheduled', 'Confirmed'].includes(a.status) && new Date(a.scheduled_at).getTime() > now && <Button variant="ghost" onClick={() => setCancel(a)}>Cancel</Button>}</td></tr>))}</tbody></table></div>
      )}
      <Modal open={!!cancel} onClose={() => setCancel(null)} title="Cancel this appointment?">
        <div className="space-y-3 text-sm">
          <p>{cancel && `${fmtDateTime(cancel.scheduled_at)} with ${cancel.doctor}`}</p>
          <p className="text-muted">Appointments can be cancelled online up to 2 hours before they start. You will get a confirmation message.</p>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setCancel(null)}>Keep appointment</Button><Button variant="danger" loading={busy} onClick={doCancel}>Cancel appointment</Button></div>
        </div>
      </Modal>
    </Card>
  );
}

function Results() {
  const q = useAsync(() => get<{ data: any[]; notice: string }>('/api/portal/results'), []);
  return (
    <Card title="Approved test results">
      {q.error ? <Alert>{q.error}</Alert> : q.loading && !q.data ? <Spinner /> : !(q.data?.data ?? []).length ? <EmptyState title="No results yet" hint="Results appear here after your doctor has reviewed them." /> : (
        <>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only-live">Test results</caption>
            <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-2"><FlaskConical className="mr-1 inline h-3 w-3" aria-hidden />Test</th><th>Date</th><th>Result</th><th>Reference range</th><th>Flag</th></tr></thead>
            <tbody>{q.data!.data.map((r) => (
              <tr key={r.id} className="border-t border-line"><td className="px-2 py-2 font-medium">{r.test}</td><td>{fmtDate(r.requested_at)}</td><td className="tabular-nums">{r.value} {r.unit}</td><td>{r.reference_range || '-'}</td>
                <td>{r.flag ? <StatusBadge status={r.flag === 'normal' ? 'In range' : r.flag === 'low' ? 'Below range' : 'Above range'} tone={FLAG_TONE[r.flag as keyof typeof FLAG_TONE]} /> : <span className="text-muted">-</span>}</td></tr>))}</tbody></table></div>
          <p className="mt-3 text-xs text-muted">{q.data!.notice}</p>
        </>
      )}
    </Card>
  );
}

function Bills() {
  const q = useAsync(() => get<{ data: any[] }>('/api/portal/invoices'), []);
  return (
    <Card title="Your bills">
      {q.error ? <Alert>{q.error}</Alert> : q.loading && !q.data ? <Spinner /> : !(q.data?.data ?? []).length ? <EmptyState title="No bills" /> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only-live">Bills</caption>
          <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-2">Invoice</th><th>Issued</th><th>Due</th><th className="text-right">Total</th><th className="text-right">Balance</th><th>Status</th><th><span className="sr-only-live">Download</span></th></tr></thead>
          <tbody>{q.data!.data.map((i) => (
            <tr key={i.id} className="border-t border-line"><td className="px-2 py-2 font-medium">{i.invoice_no}</td><td>{fmtDate(i.issued_on)}</td><td>{fmtDate(i.due_on)}</td><td className="text-right">{money(i.total)}</td><td className={cx('text-right', i.balance > 0 && 'font-semibold')}>{money(i.balance)}</td><td><StatusBadge status={i.status} /></td>
              <td className="text-right"><a href={`/api/portal/invoices/${i.id}/pdf`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-primary hover:bg-surface2" aria-label={`Download invoice ${i.invoice_no} as PDF`}><Download className="h-4 w-4" aria-hidden />PDF</a></td></tr>))}</tbody></table></div>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><FileText className="h-3.5 w-3.5" aria-hidden />Payments are taken at the front desk in this demonstration.</p>
    </Card>
  );
}

function Medicines() {
  const q = useAsync(() => get<{ data: any[] }>('/api/portal/prescriptions'), []);
  return (
    <Card title="Your prescriptions">
      {q.error ? <Alert>{q.error}</Alert> : q.loading && !q.data ? <Spinner /> : !(q.data?.data ?? []).length ? <EmptyState title="No prescriptions" /> : (
        <ul className="space-y-2">{q.data!.data.map((r) => (
          <li key={r.id} className="rounded-lg border border-line p-3 text-sm">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2"><span className="inline-flex items-center gap-1.5 font-medium"><Pill className="h-4 w-4 text-primary" aria-hidden />RX-{String(r.id).padStart(4, '0')}</span><span className="flex gap-1.5"><StatusBadge status={r.status} /><StatusBadge status={r.dispensing_status} /></span></div>
            <p className="whitespace-pre-line">{r.medicines}</p>
            <p className="mt-1 text-xs text-muted">Prescribed by {r.doctor} on {fmtDate(r.created_at)}{r.refills_allowed > 0 && ` - ${r.refills_allowed - r.refills_used} of ${r.refills_allowed} refills left`}</p>
          </li>))}</ul>
      )}
    </Card>
  );
}

function Details({ p, onSaved, email }: { p: any; onSaved: () => void; email: string }) {
  const toast = useToast();
  const [f, setF] = useState({ phone: p.phone ?? '', email: p.email ?? email, address: p.address ?? '', contact_preference: p.contact_preference as string });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await patch('/api/portal/me', f); toast('Details saved'); onSaved(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Contact details">
        <form onSubmit={save} className="space-y-3" noValidate>
          {err && <Alert>{err}</Alert>}
          <TextField label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <TextField label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <TextField label="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          <SelectField label="Appointment reminders by" value={f.contact_preference} onChange={(e) => setF({ ...f, contact_preference: e.target.value })}><option value="email">Email</option><option value="sms">Text message</option><option value="both">Email and text message</option></SelectField>
          <Button type="submit" loading={busy}>Save details</Button>
        </form>
      </Card>
      <Card title="About you">
        <dl className="grid grid-cols-2 gap-3 text-sm"><KV label="Date of birth">{fmtDate(p.dob)}</KV><KV label="Sex">{p.sex}</KV><KV label="Blood type">{p.blood_type ?? '-'}</KV><KV label="Primary doctor">{p.primary_doctor ?? '-'}</KV></dl>
        <p className="mt-3 text-xs text-muted">To correct your name, date of birth or insurance details, please speak to the front desk.</p>
      </Card>
    </div>
  );
}

function BookDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const docs = useAsync(() => (open ? get<{ data: Doctor[] }>('/api/portal/doctors') : Promise.resolve({ data: [] as Doctor[] })), [open]);
  const [doctor, setDoctor] = useState(''); const [date, setDate] = useState(''); const [time, setTime] = useState(''); const [reason, setReason] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const slots = useAsync(() => (doctor && date ? get<{ slots: { time: string; available: boolean }[]; note?: string }>(`/api/portal/slots?doctor_id=${doctor}&date=${date}`) : Promise.resolve(null)), [doctor, date]);
  const min = ymd(new Date()); const max = ymd(new Date(Date.now() + 90 * 86400000));
  const byDept = useMemo(() => {
    const m = new Map<string, Doctor[]>();
    for (const d of docs.data?.data ?? []) m.set(d.department, [...(m.get(d.department) ?? []), d]);
    return [...m.entries()];
  }, [docs.data]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await post('/api/portal/appointments', { doctor_id: Number(doctor), date, time, reason }); toast('Appointment booked. A confirmation was sent.'); setDoctor(''); setDate(''); setTime(''); setReason(''); onDone(); }
    catch (x) { setErr(errMsg(x)); slots.reload(); setTime(''); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Book an appointment" wide>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Doctor" required value={doctor} onChange={(e) => { setDoctor(e.target.value); setTime(''); }}>
            <option value="">Select...</option>{byDept.map(([dept, list]) => <optgroup key={dept} label={dept}>{list.map((d) => <option key={d.id} value={d.id}>{d.full_name} - {d.job_title}</option>)}</optgroup>)}
          </SelectField>
          <TextField label="Date" type="date" required min={min} max={max} value={date} onChange={(e) => { setDate(e.target.value); setTime(''); }} />
        </div>
        {doctor && date && (
          <fieldset><legend className="mb-1 text-xs font-medium text-muted">Available times</legend>
            {slots.loading ? <Spinner /> : slots.error ? <Alert>{slots.error}</Alert> : !slots.data?.slots.length ? <p className="text-sm text-muted">{slots.data?.note ?? 'No times on this day.'} Try another date.</p> : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Available times">
                {slots.data.slots.map((s) => (
                  <button key={s.time} type="button" role="radio" aria-checked={time === s.time} disabled={!s.available} onClick={() => setTime(s.time)}
                    className={cx('rounded-lg border px-2 py-1.5 text-sm tabular-nums', time === s.time ? 'border-primary bg-primary text-primaryfg' : s.available ? 'border-line hover:border-primary' : 'cursor-not-allowed border-line bg-surface2 text-muted line-through')}>{s.time}</button>
                ))}
              </div>
            )}
          </fieldset>
        )}
        <TextField label="Reason for the visit" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={!doctor || !date || !time}>Confirm booking</Button></div>
      </form>
    </Modal>
  );
}
