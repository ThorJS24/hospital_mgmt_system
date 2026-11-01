import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { get, money, fmtDateTime } from '../lib/api';
import { Activity, BedDouble, CalendarDays, FlaskConical, Receipt, Users } from 'lucide-react';
import { Alert, Card, EmptyState, PageHeader, Spinner, StatCard, StatusBadge, useAsync } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useLive, useLiveTick } from '../lib/live';
import { Avatar, isChild, sexToGender } from '../components/Avatar';

const axis = { stroke: 'var(--muted)', fontSize: 11 };
const tip = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6 }, labelStyle: { color: 'var(--text)' } };

export default function Dashboard() {
  const { user } = useAuth();
  const tick = useLiveTick();
  const { events } = useLive();
  const { data: d, loading, error } = useAsync(() => get('/api/dashboard'), [tick]);
  if (loading && !d) return <Spinner label="Loading dashboard" />;
  if (error || !d) return <Alert>{error ?? 'Failed to load'}</Alert>;
  const t = d.totals;
  return (
    <div className="space-y-4">
      <PageHeader title={`${new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening'}, ${user?.fullName?.replace(/^Dr\. /, '').split(' ')[0] ?? ''}`} subtitle={`${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${d.scope === 'all' ? 'Hospital-wide overview' : d.scope === 'care-team' ? 'Your care team' : 'Your department'}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {t.patients !== null && <StatCard label="Registered patients" value={t.patients} icon={Users} />}
        {t.appointmentsToday !== null && <StatCard label="Appointments today" value={t.appointmentsToday} icon={CalendarDays} tone="info" />}
        {t.admitted !== null && <StatCard label="Admitted patients" value={t.admitted} icon={Activity} tone="warn" />}
        {t.availableBeds !== null && <StatCard label="Available beds" value={t.availableBeds} icon={BedDouble} tone="ok" />}
        {t.pendingLab !== null && <StatCard label="Pending lab requests" value={t.pendingLab} icon={FlaskConical} tone="info" />}
        {t.outstandingInvoices !== null && <StatCard label="Outstanding invoices" value={t.outstandingInvoices} sub={t.outstandingAmount != null ? `${money(t.outstandingAmount)} due` : undefined} icon={Receipt} tone="danger" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {d.appointmentTrend && (
          <Card title="Appointment trend (14 days back, 7 ahead)" className="lg:col-span-2">
            <div className="h-64" role="img" aria-label="Line chart of appointments per day">
              <ResponsiveContainer><LineChart data={d.appointmentTrend}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="day" tick={axis} tickFormatter={(v: string) => v.slice(5)} /><YAxis allowDecimals={false} tick={axis} /><Tooltip {...tip} /><Line type="monotone" dataKey="appointments" stroke="var(--chart-1)" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer>
            </div>
          </Card>
        )}
        {d.staffAvailability && (
          <Card title="Staff availability">
            <ul className="space-y-2">{d.staffAvailability.map((s: any) => <li key={s.availability} className="flex items-center justify-between"><StatusBadge status={s.availability} /><span className="font-semibold">{s.n}</span></li>)}</ul>
          </Card>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {d.departmentActivity && (
          <Card title="Department activity (last 14 days)">
            {d.departmentActivity.length ? <div className="h-64" role="img" aria-label="Bar chart of appointments per department"><ResponsiveContainer><BarChart data={d.departmentActivity} layout="vertical" margin={{ left: 40 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis type="number" allowDecimals={false} tick={axis} /><YAxis type="category" dataKey="department" tick={axis} width={110} /><Tooltip {...tip} /><Bar dataKey="appointments" fill="var(--chart-2)" /></BarChart></ResponsiveContainer></div> : <EmptyState title="No activity" />}
          </Card>
        )}
        {d.admissionStats && (
          <Card title="Admission statistics">
            <ul className="space-y-2">{d.admissionStats.map((s: any) => <li key={s.status} className="flex items-center justify-between"><StatusBadge status={s.status} /><span className="font-semibold">{s.n}</span></li>)}</ul>
          </Card>
        )}
        {d.recentPatients && (
          <Card title="Recent registrations">
            <ul className="divide-y divide-line">{d.recentPatients.map((p: any) => <li key={p.id} className="flex items-center justify-between py-1.5"><Link className="inline-flex items-center gap-2.5 text-primary hover:underline" to={`/patients/${p.id}`}><Avatar name={`${p.first_name} ${p.last_name}`} gender={sexToGender(p.sex, p.id)} seed={p.id} child={isChild(p.dob)} size="xs" />{p.first_name} {p.last_name}</Link><span className="text-muted">{p.mrn}</span></li>)}</ul>
          </Card>
        )}
      </div>

      <Card title={<span className="inline-flex items-center gap-2">Live activity <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" aria-hidden /></span>}>
        {events.length === 0 ? <EmptyState title="Waiting for activity" /> : (
          <ul className="divide-y divide-line" aria-live="polite">{events.slice(0, 8).map((e) => <li key={e.id} className="flex items-center justify-between gap-3 py-1.5"><span>{e.message}</span><time className="shrink-0 text-xs text-muted" dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time></li>)}</ul>
        )}
      </Card>

      {d.recentAppointments && (
        <Card title="Nearest appointments" actions={<Link to="/appointments" className="text-xs text-primary hover:underline">View all</Link>}>
          {d.recentAppointments.length === 0 ? <EmptyState title="No appointments" /> : (
            <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-muted"><tr><th className="py-1 pr-3">When</th><th className="pr-3">Patient</th><th className="pr-3">Doctor</th><th className="pr-3">Department</th><th>Status</th></tr></thead>
              <tbody>{d.recentAppointments.map((a: any) => <tr key={a.id} className="border-t border-line"><td className="py-1.5 pr-3 whitespace-nowrap">{fmtDateTime(a.scheduled_at)}</td><td className="pr-3">{a.patient}</td><td className="pr-3">{a.doctor}</td><td className="pr-3">{a.department}</td><td><StatusBadge status={a.status} /></td></tr>)}</tbody></table></div>
          )}
        </Card>
      )}
    </div>
  );
}
