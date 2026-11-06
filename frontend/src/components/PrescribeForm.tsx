import { useState } from 'react';
import { ShieldAlert, Trash2 } from 'lucide-react';
import { ApiError, get, post } from '../lib/api';
import { Alert, Button, SelectField, StatusBadge, TextArea, TextField, errMsg, useAsync } from './ui';

export interface RxWarning { type: 'allergy' | 'interaction' | 'dose' | 'stock' | 'duplicate'; severity: 'Minor' | 'Moderate' | 'Major'; blocking: boolean; message: string }
interface Med { id: number; name: string; strength: string; form: string; drug_class?: string; max_daily_units?: number | null }
interface Draft { medication_id: string; quantity: string; dosage: string; units_per_dose: string; doses_per_day: string }
export interface RxPayload { items: { medication_id: number; quantity: number; dosage: string; units_per_dose?: number; doses_per_day?: number }[]; refills_allowed: number; override_reason?: string }

const blank = (): Draft => ({ medication_id: '', quantity: '10', dosage: '', units_per_dose: '', doses_per_day: '' });
const TYPE_LABEL: Record<RxWarning['type'], string> = { allergy: 'Allergy', interaction: 'Interaction', dose: 'Maximum dose', stock: 'Stock', duplicate: 'Duplicate' };

export function RxWarnings({ warnings }: { warnings: RxWarning[] }) {
  if (!warnings.length) return <Alert tone="ok">No allergy, interaction or dose problems found.</Alert>;
  return (
    <ul className="space-y-1.5" aria-label="Prescribing safety checks">
      {warnings.map((w, i) => (
        <li key={i} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${w.blocking ? 'border-danger/40 bg-danger/10' : 'border-line bg-surface2/50'}`}>
          <ShieldAlert className={`mt-0.5 h-4 w-4 shrink-0 ${w.blocking ? 'text-danger' : 'text-warn'}`} aria-hidden />
          <span className="flex-1"><strong>{TYPE_LABEL[w.type]}.</strong> {w.message}</span>
          <span className="flex shrink-0 flex-col items-end gap-1"><StatusBadge status={w.severity} tone={w.severity === 'Major' ? 'danger' : w.severity === 'Moderate' ? 'warn' : 'info'} />{w.blocking && <span className="text-[11px] font-semibold text-danger">Blocks prescribing</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Prescription entry with live safety checks. A blocking finding (severe allergy, major interaction, dose above the maximum)
 * stops submission until the prescriber documents an override reason; the server enforces the same rule.
 */
export function PrescribeForm({ patientId, onSubmit, onDone, submitLabel = 'Issue prescription' }: {
  patientId: number | null;
  onSubmit: (payload: RxPayload) => Promise<{ warnings?: RxWarning[] }>;
  onDone: (warnings: RxWarning[]) => void;
  submitLabel?: string;
}) {
  const meds = useAsync(() => get<{ data: Med[] }>('/api/pharmacy/medications?pageSize=100'), []);
  const [items, setItems] = useState<Draft[]>([blank()]);
  const [refills, setRefills] = useState('0');
  const [notes, setNotes] = useState('');
  const [override, setOverride] = useState('');
  const [warnings, setWarnings] = useState<RxWarning[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const upd = (i: number, k: keyof Draft, v: string) => { setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it))); setWarnings(null); };
  const payload = (): RxPayload => ({
    items: items.map((i) => ({
      medication_id: Number(i.medication_id), quantity: Number(i.quantity), dosage: i.dosage.trim(),
      ...(i.units_per_dose && { units_per_dose: Number(i.units_per_dose) }), ...(i.doses_per_day && { doses_per_day: Number(i.doses_per_day) }),
    })),
    refills_allowed: Number(refills) || 0,
    ...(notes.trim() && { notes: notes.trim() }),
  } as RxPayload);
  const ready = !!patientId && items.every((i) => i.medication_id && Number(i.quantity) >= 1 && i.dosage.trim().length >= 2);
  const blocked = !!warnings?.some((w) => w.blocking);
  const overrideOk = override.trim().length >= 10;

  const check = async () => {
    if (!ready) return;
    setBusy(true); setErr('');
    try { const r = await post('/api/pharmacy/prescriptions/check', { patient_id: patientId, items: payload().items }); setWarnings(r.warnings); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setErr('');
    try {
      const r = await onSubmit({ ...payload(), ...(blocked && overrideOk && { override_reason: override.trim() }) });
      onDone(r.warnings ?? warnings ?? []);
      setItems([blank()]); setRefills('0'); setNotes(''); setOverride(''); setWarnings(null);
    } catch (x) {
      const details = x instanceof ApiError ? (x.details as unknown as { warnings?: RxWarning[] } | undefined) : undefined;
      if (x instanceof ApiError && x.status === 409 && details?.warnings) { setWarnings(details.warnings); setErr('Safety checks found a problem that blocks this prescription.'); }
      else setErr(errMsg(x));
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      {err && <Alert tone={warnings?.some((w) => w.blocking) ? 'warn' : 'danger'}>{err}</Alert>}
      {items.map((it, i) => {
        const m = meds.data?.data.find((x) => String(x.id) === it.medication_id);
        return (
          <fieldset key={i} className="space-y-2 rounded-md border border-line p-2">
            <legend className="px-1 text-xs text-muted">Item {i + 1}</legend>
            <div className="grid items-end gap-2 sm:grid-cols-[2fr_6rem_2fr_auto]">
              <SelectField label="Medication" required value={it.medication_id} onChange={(e) => upd(i, 'medication_id', e.target.value)}>
                <option value="">Select...</option>{(meds.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} {x.strength}</option>)}
              </SelectField>
              <TextField label="Quantity" type="number" min={1} max={500} required value={it.quantity} onChange={(e) => upd(i, 'quantity', e.target.value)} />
              <TextField label="Dosage instructions" required value={it.dosage} onChange={(e) => upd(i, 'dosage', e.target.value)} />
              {items.length > 1 && <Button type="button" variant="ghost" aria-label={`Remove item ${i + 1}`} onClick={() => { setItems(items.filter((_, j) => j !== i)); setWarnings(null); }}><Trash2 className="h-4 w-4" /></Button>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField label="Units per dose" type="number" min={1} max={20} value={it.units_per_dose} onChange={(e) => upd(i, 'units_per_dose', e.target.value)} hint={m?.max_daily_units ? `Maximum ${m.max_daily_units} units/day` : 'Optional: enables the maximum daily dose check'} />
              <TextField label="Doses per day" type="number" min={1} max={12} value={it.doses_per_day} onChange={(e) => upd(i, 'doses_per_day', e.target.value)} />
            </div>
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-end gap-3">
        <Button type="button" variant="secondary" onClick={() => { setItems([...items, blank()]); setWarnings(null); }} disabled={items.length >= 10}>Add item</Button>
        <div className="w-32"><TextField label="Refills allowed" type="number" min={0} max={5} value={refills} onChange={(e) => setRefills(e.target.value)} /></div>
        <div className="min-w-48 flex-1"><TextField label="Notes to the pharmacist" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </div>
      {warnings && <RxWarnings warnings={warnings} />}
      {blocked && (
        <TextArea label="Override reason (required to prescribe despite the blocking findings)" required value={override} onChange={(e) => setOverride(e.target.value)}
          hint="Document why the benefit outweighs the risk (at least 10 characters). The override is audited." error={override && !overrideOk ? 'Please give a fuller reason' : undefined} />
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" disabled={!ready} loading={busy && !blocked} onClick={check}>Check safety</Button>
        <Button type="button" disabled={!ready || (blocked && !overrideOk)} loading={busy} onClick={submit}>{blocked ? 'Prescribe with override' : submitLabel}</Button>
      </div>
    </div>
  );
}
