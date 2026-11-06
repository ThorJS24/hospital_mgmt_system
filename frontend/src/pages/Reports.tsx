import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BedDouble, Download, ReceiptText, Timer } from 'lucide-react';
import { get, money } from '../lib/api';
import { useT } from '../lib/i18n';
import { Alert, Card, EmptyState, PageHeader, Spinner, StatCard, StatusBadge, cx, useAsync } from '../components/ui';

const axis = { stroke: 'var(--muted)', fontSize: 11 };
const tip = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6 } };

const EXPORTS = [
  ['occupancy', 'Bed occupancy by ward'], ['collections', 'Collections by month'], ['waits', 'Wait times'],
  ['aging', 'Receivables aging'], ['appointments', 'Appointments by department'], ['claims', 'Insurance claims'],
] as const;

export default function Reports() {
  const { t } = useT();
  const { data: d, loading, error } = useAsync(() => get('/api/reports/operational'), []);
  const sum = useAsync(() => get('/api/reports/summary'), []);
  if (loading) return <Spinner label="Building reports" />;
  if (error || !d) return <Alert>{error ?? 'Failed to load'}</Alert>;
  return (
    <div className="space-y-4">
      <PageHeader title={t('page.reports')} subtitle="Computed live from synthetic records" />
      {sum.data && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Bed occupancy" value={`${sum.data.occupancy.percent}%`} icon={BedDouble} tone={sum.data.occupancy.percent > 85 ? 'danger' : sum.data.occupancy.percent > 70 ? 'warn' : 'ok'} sub={`${sum.data.occupancy.occupied} of ${sum.data.occupancy.beds} beds in use`} />
          <StatCard label="Triage wait (ESI 3, avg)" value={`${sum.data.waits.find((w: any) => w.area.startsWith('Emergency') && w.group === 'ESI 3')?.avg ?? '-'} min`} icon={Timer} tone="info" sub="From arrival to start of treatment" />
          <StatCard label="Lab turnaround (avg)" value={`${(() => { const l = sum.data.waits.filter((w: any) => w.area.startsWith('Laboratory')); return l.length ? (l.reduce((a: number, w: any) => a + Number(w.avg), 0) / l.length).toFixed(1) : '-'; })()} h`} icon={Timer} tone="info" sub="Request to result" />
          <StatCard label="Claims awaiting decision" value={sum.data.claims.find((c: any) => c.status === 'Submitted')?.claims ?? 0} icon={ReceiptText} tone="warn" />
        </div>
      )}
      {sum.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Bed occupancy by ward">
            <ul className="space-y-2.5" aria-label="Bed occupancy by ward">
              {sum.data.occupancy.rows.map((w: any) => (
                <li key={w.ward}>
                  <div className="mb-0.5 flex justify-between text-sm"><span>{w.ward}</span><span className="tabular-nums text-muted">{w.occupied}/{w.beds} ({w.percent}%)</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.percent} aria-label={`${w.ward} occupancy`}>
                    <div className={cx('h-full rounded-full', w.percent > 85 ? 'bg-danger' : w.percent > 70 ? 'bg-warn' : 'bg-ok')} style={{ width: `${w.percent}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Wait times">
            <table className="w-full text-left text-sm"><caption className="sr-only-live">Wait times</caption>
              <thead className="text-xs uppercase text-muted"><tr><th className="py-1">Area</th><th>Group</th><th className="text-right">Count</th><th className="text-right">Average</th><th className="text-right">Longest</th></tr></thead>
              <tbody>{sum.data.waits.map((w: any, i: number) => <tr key={i} className="border-t border-line"><td className="py-1">{w.area}</td><td>{w.group}</td><td className="text-right">{w.count}</td><td className="text-right tabular-nums">{w.avg}</td><td className="text-right tabular-nums">{w.max ?? '-'}</td></tr>)}</tbody></table>
          </Card>
        </div>
      )}
      <Card title="Export">
        <p className="mb-3 text-sm text-muted">Download any report as a spreadsheet-safe CSV or a printable PDF. Exports are recorded in the activity log.</p>
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {EXPORTS.map(([key, label]) => (
            <li key={key} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
              <span>{label}</span>
              <span className="flex gap-1.5">
                <a className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-medium hover:bg-surface2" href={`/api/reports/export?report=${key}&format=csv`} aria-label={`Download ${label} as CSV`}><Download className="h-3 w-3" aria-hidden />CSV</a>
                <a className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-medium hover:bg-surface2" href={`/api/reports/export?report=${key}&format=pdf`} aria-label={`Download ${label} as PDF`}><Download className="h-3 w-3" aria-hidden />PDF</a>
              </span>
            </li>
          ))}
        </ul>
      </Card>
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
