import { useMemo, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { del, get, post, put, fmtDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SelectField, Spinner, StatusBadge, Tabs, TextField, cx, errMsg, useAsync, useToast } from '../components/ui';

interface Shift { weekday: number; start_time: string; end_time: string }
interface RosterRow { id: number; staff_code: string; full_name: string; job_title: string; department: string; shifts: Shift[]; leave: { start_date: string; end_date: string }[] }
interface Leave { id: number; staff_id: number; staff: string; status: 'Pending' | 'Approved' | 'Rejected'; reason: string; start_date: string; end_date: string }
const DAYS = [{ n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' }, { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 0, label: 'Sun' }];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function Roster() {
  const { can, user } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const [tab, setTab] = useState('roster');
  const [dept, setDept] = useState('');
  const roster = useAsync(() => get<{ data: RosterRow[] }>(`/api/roster${dept ? `?department_id=${dept}` : ''}`), [dept]);
  const depts = useAsync(() => get<{ data: { id: number; name: string }[] }>('/api/departments'), []);
  const [edit, setEdit] = useState<RosterRow | null>(null);
  const today = ymd(new Date());

  return (
    <div className="space-y-4">
      <PageHeader title={t('page.roster')} subtitle="Weekly shifts, leave requests and bookable appointment slots" />
      <Card>
        <Tabs tabs={[{ id: 'roster', label: 'Weekly roster' }, { id: 'leave', label: 'Leave' }, { id: 'slots', label: 'Appointment slots' }]} value={tab} onChange={setTab} />
        <div className="mt-3">
          {tab === 'roster' && (
            <>
              <div className="mb-3 max-w-xs"><SelectField label="Department" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All departments</option>{(depts.data?.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</SelectField></div>
              {roster.error ? <Alert>{roster.error}</Alert> : roster.loading && !roster.data ? <Spinner /> : !(roster.data?.data ?? []).length ? <EmptyState title="No staff found" /> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[56rem] text-left text-sm"><caption className="sr-only-live">Weekly staff roster</caption>
                    <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-2">Staff</th>{DAYS.map((d) => <th key={d.n} className="px-1 text-center">{d.label}</th>)}<th><span className="sr-only-live">Actions</span></th></tr></thead>
                    <tbody>
                      {roster.data!.data.map((s) => {
                        const onLeave = s.leave.find((l) => l.start_date <= today && l.end_date >= today);
                        const upcoming = s.leave.find((l) => l.start_date > today);
                        return (
                          <tr key={s.id} className="border-t border-line align-top">
                            <td className="px-2 py-2"><strong>{s.full_name}</strong><span className="block text-xs text-muted">{s.job_title} - {s.department}</span>
                              {onLeave && <StatusBadge status={`On leave until ${fmtDate(onLeave.end_date)}`} tone="warn" />}
                              {!onLeave && upcoming && <span className="block text-xs text-muted">Leave {fmtDate(upcoming.start_date)} to {fmtDate(upcoming.end_date)}</span>}</td>
                            {DAYS.map((d) => {
                              const sh = s.shifts.filter((x) => x.weekday === d.n);
                              return <td key={d.n} className="px-1 py-2 text-center text-xs">{sh.length ? sh.map((x, i) => <span key={i} className="mb-0.5 block rounded bg-primary/10 px-1 py-0.5 tabular-nums text-primary">{x.start_time}-{x.end_time}</span>) : <span className="text-muted">-</span>}</td>;
                            })}
                            <td className="px-2 text-right">{can('roster.manage') && <Button variant="ghost" onClick={() => setEdit(s)}>Edit</Button>}</td>
                          </tr>
                        );
                      })}
                    </tbody></table>
                </div>
              )}
            </>
          )}
          {tab === 'leave' && <LeavePanel />}
          {tab === 'slots' && <SlotsPanel />}
        </div>
      </Card>
      <ShiftEditor target={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); toast('Roster updated'); roster.reload(); }} />
      {!user?.staffId && tab === 'leave' && <Alert tone="info">Your account is not linked to a staff profile, so you cannot request leave.</Alert>}
    </div>
  );
}

function LeavePanel() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const leave = useAsync(() => get<{ data: Leave[] }>(`/api/leave${status ? `?status=${status}` : ''}`), [status]);
  const [open, setOpen] = useState(false);
  const decide = async (l: Leave, s: 'Approved' | 'Rejected') => {
    try {
      const r = await post(`/api/leave/${l.id}/decision`, { status: s });
      toast(s === 'Approved' && r.appointmentConflicts ? `Approved. ${r.appointmentConflicts} booked appointment(s) in this period need rescheduling.` : `Leave ${s.toLowerCase()}`, 'ok');
      leave.reload();
    } catch (x) { toast(errMsg(x), 'danger'); }
  };
  const withdraw = async (l: Leave) => { try { await del(`/api/leave/${l.id}`); toast('Request withdrawn'); leave.reload(); } catch (x) { toast(errMsg(x), 'danger'); } };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="w-48"><SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option>Pending</option><option>Approved</option><option>Rejected</option></SelectField></div>
        {can('leave.request') && user?.staffId && <Button onClick={() => setOpen(true)}><CalendarPlus className="h-4 w-4" />Request leave</Button>}
      </div>
      {leave.error ? <Alert>{leave.error}</Alert> : leave.loading && !leave.data ? <Spinner /> : !(leave.data?.data ?? []).length ? <EmptyState title="No leave requests" /> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only-live">Leave requests</caption>
          <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-2">Staff</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th><span className="sr-only-live">Actions</span></th></tr></thead>
          <tbody>{leave.data!.data.map((l) => (
            <tr key={l.id} className="border-t border-line">
              <td className="px-2 py-2 font-medium">{l.staff}</td><td>{fmtDate(l.start_date)}</td><td>{fmtDate(l.end_date)}</td><td className="max-w-xs">{l.reason || <span className="text-muted">-</span>}</td>
              <td><StatusBadge status={l.status} tone={l.status === 'Approved' ? 'ok' : l.status === 'Rejected' ? 'danger' : 'warn'} /></td>
              <td className="text-right">{l.status === 'Pending' && (
                <div className="flex justify-end gap-1.5">
                  {can('leave.decide') && l.staff_id !== user?.staffId && <><Button onClick={() => void decide(l, 'Approved')}>Approve</Button><Button variant="secondary" onClick={() => void decide(l, 'Rejected')}>Reject</Button></>}
                  {(can('leave.decide') || l.staff_id === user?.staffId) && <Button variant="ghost" onClick={() => void withdraw(l)}>Withdraw</Button>}
                </div>)}</td>
            </tr>))}</tbody></table></div>
      )}
      <LeaveDialog open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); toast('Leave requested'); leave.reload(); }} />
    </div>
  );
}

function LeaveDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ start_date: '', end_date: '', reason: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await post('/api/leave', f); setF({ start_date: '', end_date: '', reason: '' }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Request leave">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="First day" type="date" required min={ymd(new Date())} value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value, end_date: f.end_date < e.target.value ? e.target.value : f.end_date })} />
          <TextField label="Last day" type="date" required min={f.start_date || ymd(new Date())} value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} />
        </div>
        <TextField label="Reason" maxLength={200} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} hint="Visible only to you and the leave approvers" />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={!f.start_date || !f.end_date}>Submit request</Button></div>
      </form>
    </Modal>
  );
}

function SlotsPanel() {
  const docs = useAsync(() => get<{ data: { id: number; full_name: string; department: string }[] }>('/api/staff?kind=doctor&pageSize=50'), []);
  const [doc, setDoc] = useState('');
  const [date, setDate] = useState(ymd(new Date()));
  const slots = useAsync(() => (doc ? get<{ slots: { time: string; available: boolean; reason?: string }[]; note?: string }>(`/api/staff/${doc}/slots?date=${date}`) : Promise.resolve(null)), [doc, date]);
  const free = useMemo(() => (slots.data?.slots ?? []).filter((s) => s.available).length, [slots.data]);
  return (
    <div>
      <div className="mb-3 grid max-w-2xl gap-3 sm:grid-cols-2">
        <SelectField label="Doctor" value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">Select...</option>{(docs.data?.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.full_name} - {d.department}</option>)}</SelectField>
        <TextField label="Date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </div>
      {!doc ? <EmptyState title="Choose a doctor" hint="Slots come from the weekly roster, approved leave and existing bookings." /> : slots.error ? <Alert>{slots.error}</Alert> : slots.loading ? <Spinner /> : !slots.data?.slots.length ? <Alert tone="info">{slots.data?.note ?? 'No slots on this day.'}</Alert> : (
        <>
          <p className="mb-2 text-sm text-muted">{free} of {slots.data.slots.length} slots available</p>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8" aria-label="Appointment slots">
            {slots.data.slots.map((s) => <li key={s.time} className={cx('rounded-lg border px-2 py-1.5 text-center text-sm tabular-nums', s.available ? 'border-ok/50 bg-ok/10 text-ok' : 'border-line bg-surface2 text-muted line-through')}>{s.time}<span className="sr-only-live"> {s.available ? 'available' : s.reason}</span></li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function ShiftEditor({ target, onClose, onDone }: { target: RosterRow | null; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<Record<number, { on: boolean; start: string; end: string }>>({});
  const [seen, setSeen] = useState<number | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (target && seen !== target.id) {
    setSeen(target.id); setErr('');
    setPlan(Object.fromEntries(DAYS.map((d) => { const s = target.shifts.find((x) => x.weekday === d.n); return [d.n, { on: !!s, start: s?.start_time ?? '08:00', end: s?.end_time ?? '16:00' }]; })));
  }
  const save = async () => {
    if (!target) return;
    setBusy(true); setErr('');
    try { await put(`/api/staff/${target.id}/shifts`, { shifts: DAYS.filter((d) => plan[d.n]?.on).map((d) => ({ weekday: d.n, start_time: plan[d.n].start, end_time: plan[d.n].end })) }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!target} onClose={onClose} title={target ? `Edit shifts: ${target.full_name}` : ''}>
      <div className="space-y-2">
        {err && <Alert>{err}</Alert>}
        {DAYS.map((d) => {
          const p = plan[d.n] ?? { on: false, start: '08:00', end: '16:00' };
          return (
            <div key={d.n} className="flex items-center gap-3">
              <label className="flex w-20 items-center gap-2 text-sm"><input type="checkbox" checked={p.on} onChange={(e) => setPlan({ ...plan, [d.n]: { ...p, on: e.target.checked } })} />{d.label}</label>
              <input type="time" aria-label={`${d.label} start`} disabled={!p.on} value={p.start} onChange={(e) => setPlan({ ...plan, [d.n]: { ...p, start: e.target.value } })} className="rounded-lg border border-line bg-surface px-2 py-1 text-sm disabled:opacity-40" />
              <span className="text-muted">to</span>
              <input type="time" aria-label={`${d.label} end`} disabled={!p.on} value={p.end} onChange={(e) => setPlan({ ...plan, [d.n]: { ...p, end: e.target.value } })} className="rounded-lg border border-line bg-surface px-2 py-1 text-sm disabled:opacity-40" />
            </div>
          );
        })}
        <div className="flex justify-end gap-2 pt-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save roster</Button></div>
      </div>
    </Modal>
  );
}
