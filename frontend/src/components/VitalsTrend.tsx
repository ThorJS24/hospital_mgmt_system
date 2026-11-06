import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Plus } from 'lucide-react';
import { get, post, fmtDateTime } from '../lib/api';
import { useLiveTick } from '../lib/live';
import { Alert, Button, Card, EmptyState, Modal, Spinner, StatusBadge, TextField, cx, errMsg, useAsync, useToast } from './ui';

type Flag = 'low' | 'high' | 'critical-low' | 'critical-high' | null;
interface Reading { id: number; recorded_at: string; systolic: number; diastolic: number; heart_rate: number; temperature_c: number; spo2: number; weight_kg: number; flags: Record<string, Flag> }
interface Trend { data: Reading[]; age: number; ranges: Record<string, { lo: number; hi: number }>; abnormalCount: number }

const METRICS = [
  { key: 'systolic', label: 'Systolic', unit: 'mmHg' }, { key: 'diastolic', label: 'Diastolic', unit: 'mmHg' }, { key: 'heart_rate', label: 'Heart rate', unit: 'bpm' },
  { key: 'temperature_c', label: 'Temperature', unit: '°C' }, { key: 'spo2', label: 'SpO₂', unit: '%' },
] as const;
const flagText = (f: Flag) => (f === 'critical-high' ? 'Critically high' : f === 'critical-low' ? 'Critically low' : f === 'high' ? 'High' : f === 'low' ? 'Low' : '');
const isCritical = (f: Flag) => f === 'critical-high' || f === 'critical-low';
const axis = { stroke: 'var(--muted)', fontSize: 11 };
const tip = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6 } };
const shortTime = (s: string) => new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function MiniChart({ title, unit, rows, metrics, ranges }: { title: string; unit: string; rows: Reading[]; metrics: { key: keyof Reading & string; color: string; name: string }[]; ranges: Trend['ranges'] }) {
  const first = ranges[metrics[0].key];
  const values = rows.flatMap((r) => metrics.map((m) => Number(r[m.key])));
  const lo = Math.min(first.lo, ...values), hi = Math.max(first.hi, ...values);
  const pad = Math.max(2, (hi - lo) * 0.12);
  const data = rows.map((r) => ({ ...r, label: shortTime(r.recorded_at) }));
  const abnormal = rows.filter((r) => metrics.some((m) => r.flags[m.key])).length;
  return (
    <figure className="rounded-lg border border-line p-3">
      <figcaption className="mb-1 flex items-center justify-between text-sm font-medium">{title} <span className="text-xs font-normal text-muted">{unit}{abnormal > 0 && <span className="ml-2 text-warn">{abnormal} abnormal</span>}</span></figcaption>
      <div className="h-44" role="img" aria-label={`${title} trend over ${rows.length} readings, normal range ${first.lo} to ${first.hi} ${unit}`}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ ...axis, fontSize: 10 }} interval="preserveStartEnd" minTickGap={28} />
            <YAxis tick={axis} domain={[Math.floor(lo - pad), Math.ceil(hi + pad)]} />
            <ReferenceArea y1={first.lo} y2={first.hi} fill="var(--ok)" fillOpacity={0.1} ifOverflow="extendDomain" />
            <Tooltip {...tip} />
            {metrics.map((m) => (
              <Line key={m.key} type="monotone" dataKey={m.key} name={m.name} stroke={m.color} strokeWidth={2} isAnimationActive={false}
                dot={(p: { cx?: number; cy?: number; payload?: Reading; index?: number }) => {
                  const f = p.payload?.flags[m.key] ?? null;
                  if (p.cx == null || p.cy == null) return <g key={p.index} />;
                  return f
                    ? <circle key={p.index} cx={p.cx} cy={p.cy} r={isCritical(f) ? 6 : 5} fill="var(--danger)" stroke="var(--surface)" strokeWidth={1.5}><title>{`${m.name}: ${flagText(f)}`}</title></circle>
                    : <circle key={p.index} cx={p.cx} cy={p.cy} r={3} fill={m.color} />;
                }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function VitalsTrend({ patientId, canRecord }: { patientId: number; canRecord: boolean }) {
  const tick = useLiveTick();
  const toast = useToast();
  const q = useAsync(() => get<Trend>(`/api/patients/${patientId}/vitals/trend?limit=30`), [patientId, tick]);
  const [open, setOpen] = useState(false);
  const latest = q.data?.data[q.data.data.length - 1];
  const rowsDesc = useMemo(() => [...(q.data?.data ?? [])].reverse(), [q.data]);

  if (q.loading && !q.data) return <Spinner />;
  if (q.error || !q.data) return <Alert>{q.error ?? 'Could not load vitals'}</Alert>;
  const { data, ranges, abnormalCount } = q.data;
  const Tile = ({ label, value, unit, flag }: { label: string; value: string | number; unit: string; flag: Flag }) => (
    <div className={cx('rounded-lg border p-3', isCritical(flag) ? 'border-danger bg-danger/10' : flag ? 'border-warn/60 bg-warn/10' : 'border-line')}>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-xl font-semibold">{value}<span className="ml-1 text-sm font-normal text-muted">{unit}</span></p>
      {flag && <p className={cx('mt-0.5 flex items-center gap-1 text-xs font-medium', isCritical(flag) ? 'text-danger' : 'text-warn')}><AlertTriangle className="h-3 w-3" aria-hidden />{flagText(flag)}</p>}
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{data.length ? `${data.length} reading${data.length === 1 ? '' : 's'}, ${abnormalCount} outside the ${q.data.age < 12 ? 'paediatric' : 'adult'} reference range` : 'No readings yet'}</p>
        {canRecord && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Record vitals</Button>}
      </div>
      {!data.length || !latest ? <Card title="Vitals"><EmptyState title="No vitals recorded" /></Card> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Tile label="Blood pressure" value={`${latest.systolic}/${latest.diastolic}`} unit="mmHg" flag={[latest.flags.systolic, latest.flags.diastolic].find(isCritical) ?? latest.flags.systolic ?? latest.flags.diastolic} />
            <Tile label="Heart rate" value={latest.heart_rate} unit="bpm" flag={latest.flags.heart_rate} />
            <Tile label="Temperature" value={latest.temperature_c} unit="°C" flag={latest.flags.temperature_c} />
            <Tile label="SpO₂" value={latest.spo2} unit="%" flag={latest.flags.spo2} />
            <Tile label="Weight" value={latest.weight_kg} unit="kg" flag={null} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <MiniChart title="Blood pressure" unit="mmHg" rows={data} ranges={ranges} metrics={[{ key: 'systolic', color: 'var(--primary)', name: 'Systolic' }, { key: 'diastolic', color: 'var(--info)', name: 'Diastolic' }]} />
            <MiniChart title="Heart rate" unit="bpm" rows={data} ranges={ranges} metrics={[{ key: 'heart_rate', color: 'var(--primary)', name: 'Heart rate' }]} />
            <MiniChart title="Temperature" unit="°C" rows={data} ranges={ranges} metrics={[{ key: 'temperature_c', color: 'var(--warn)', name: 'Temperature' }]} />
            <MiniChart title="Oxygen saturation" unit="%" rows={data} ranges={ranges} metrics={[{ key: 'spo2', color: 'var(--info)', name: 'SpO₂' }]} />
          </div>
          <Card title="Readings">
            <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only-live">Vital sign readings, newest first</caption>
              <thead className="text-xs uppercase text-muted"><tr><th className="px-2 py-1">Recorded</th>{METRICS.map((m) => <th key={m.key} className="px-2">{m.label}</th>)}<th className="px-2">Weight</th></tr></thead>
              <tbody>{rowsDesc.map((r) => (
                <tr key={r.id} className="border-t border-line"><td className="px-2 py-1.5 whitespace-nowrap">{fmtDateTime(r.recorded_at)}</td>
                  {METRICS.map((m) => { const f = r.flags[m.key]; return <td key={m.key} className="px-2">{String(r[m.key])} {f && <StatusBadge status={flagText(f)} tone={isCritical(f) ? 'danger' : 'warn'} />}</td>; })}
                  <td className="px-2">{r.weight_kg} kg</td></tr>))}</tbody></table></div>
          </Card>
        </>
      )}
      <RecordDialog open={open} patientId={patientId} onClose={() => setOpen(false)} onDone={(critical) => { setOpen(false); toast(critical ? 'Recorded. Critical values were reported to the primary doctor.' : 'Vitals recorded'); q.reload(); }} />
    </div>
  );
}

function RecordDialog({ open, patientId, onClose, onDone }: { open: boolean; patientId: number; onClose: () => void; onDone: (critical: boolean) => void }) {
  const blank = { systolic: '', diastolic: '', heart_rate: '', temperature_c: '', spo2: '', weight_kg: '' };
  const [f, setF] = useState(blank); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const complete = Object.values(f).every((v) => v !== '');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await post(`/api/patients/${patientId}/vitals`, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v)])));
      setF(blank); onDone(Object.values(r.flags as Record<string, Flag>).some(isCritical));
    } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Record vital signs">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Systolic (mmHg)" type="number" min={40} max={300} required value={f.systolic} onChange={set('systolic')} />
          <TextField label="Diastolic (mmHg)" type="number" min={20} max={200} required value={f.diastolic} onChange={set('diastolic')} />
          <TextField label="Heart rate (bpm)" type="number" min={20} max={250} required value={f.heart_rate} onChange={set('heart_rate')} />
          <TextField label="Temperature (°C)" type="number" step="0.1" min={30} max={45} required value={f.temperature_c} onChange={set('temperature_c')} />
          <TextField label="SpO₂ (%)" type="number" min={50} max={100} required value={f.spo2} onChange={set('spo2')} />
          <TextField label="Weight (kg)" type="number" step="0.1" min={0.5} max={500} required value={f.weight_kg} onChange={set('weight_kg')} />
        </div>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={!complete}>Save readings</Button></div>
      </form>
    </Modal>
  );
}
