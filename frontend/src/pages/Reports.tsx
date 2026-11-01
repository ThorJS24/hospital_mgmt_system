import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { get, money } from '../lib/api';
import { Alert, Card, EmptyState, PageHeader, Spinner, StatusBadge, useAsync } from '../components/ui';

const axis = { stroke: 'var(--muted)', fontSize: 11 };
const tip = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6 } };

export default function Reports() {
  const { data: d, loading, error } = useAsync(() => get('/api/reports/operational'), []);
  if (loading) return <Spinner label="Building reports" />;
  if (error || !d) return <Alert>{error ?? 'Failed to load'}</Alert>;
  return (
    <div className="space-y-4">
      <PageHeader title="Operational reports" subtitle="Computed live from synthetic records" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Appointments by department"><div className="h-64" role="img" aria-label="Bar chart of appointments by department"><ResponsiveContainer><BarChart data={d.appointmentsByDepartment}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="department" tick={axis} interval={0} angle={-20} textAnchor="end" height={60} /><YAxis allowDecimals={false} tick={axis} /><Tooltip {...tip} /><Bar dataKey="appointments" fill="var(--chart-1)" /></BarChart></ResponsiveContainer></div></Card>
        <Card title="Collections by month">{d.collectionsByMonth.length ? <div className="h-64" role="img" aria-label="Bar chart of payments collected per month"><ResponsiveContainer><BarChart data={d.collectionsByMonth}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="month" tick={axis} /><YAxis tick={axis} /><Tooltip {...tip} formatter={(v) => money(Number(v))} /><Bar dataKey="collected" fill="var(--chart-2)" /></BarChart></ResponsiveContainer></div> : <EmptyState title="No payments yet" />}</Card>
        <Card title="Receivables aging"><table className="w-full text-left text-sm"><caption className="sr-only-live">Receivables aging</caption><thead className="text-xs uppercase text-muted"><tr><th className="py-1">Bucket</th><th className="text-right">Invoices</th><th className="text-right">Balance</th></tr></thead><tbody>{d.receivablesAging.map((r: any) => <tr key={r.bucket} className="border-t border-line"><td className="py-1.5">{r.bucket}</td><td className="text-right">{r.invoices}</td><td className="text-right">{money(r.balance)}</td></tr>)}</tbody></table></Card>
        <Card title="Status summaries">
          <div className="grid gap-4 sm:grid-cols-2">
            <div><h3 className="mb-1 text-xs font-semibold uppercase text-muted">Appointments</h3><ul className="space-y-1">{d.appointmentsByStatus.map((s: any) => <li key={s.status} className="flex justify-between"><StatusBadge status={s.status} /><strong>{s.n}</strong></li>)}</ul></div>
            <div><h3 className="mb-1 text-xs font-semibold uppercase text-muted">Laboratory</h3><ul className="space-y-1">{d.labByStatus.map((s: any) => <li key={s.status} className="flex justify-between"><StatusBadge status={s.status} /><strong>{s.n}</strong></li>)}</ul></div>
          </div>
        </Card>
      </div>
    </div>
  );
}
