import { useEffect, useState } from 'react';
import { CalendarPlus, Download } from 'lucide-react';
import { get, post, put, fmtDateTime } from '../lib/api';
import { Alert, Button, Modal, Spinner, StatusBadge, TextArea, TextField, errMsg, useAsync, useToast } from './ui';

interface Summary { diagnosis: string; hospital_course: string; discharge_medications: string; instructions: string; follow_up_appointment_id: number | null; follow_up_at: string | null; follow_up_doctor: string | null }
const todayPlus = (n: number) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Discharge summary editor with printable PDF and one-step follow-up booking with the attending doctor. */
export function DischargeSummary({ admissionId, canWrite, onClose }: { admissionId: number | null; canWrite: boolean; onClose: () => void }) {
  const toast = useToast();
  const q = useAsync(() => (admissionId ? get(`/api/admissions/${admissionId}/discharge-summary`) : Promise.resolve(null)), [admissionId]);
  const [f, setF] = useState({ diagnosis: '', hospital_course: '', discharge_medications: '', instructions: '' });
  const [fuDate, setFuDate] = useState(todayPlus(7)); const [fuTime, setFuTime] = useState('10:00');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(''); const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    const s: Summary | null = q.data.summary;
    setF({ diagnosis: s?.diagnosis || q.data.suggestions.diagnosis || '', hospital_course: s?.hospital_course ?? '', discharge_medications: s?.discharge_medications || q.data.suggestions.medications || '', instructions: s?.instructions ?? '' });
    setSaved(!!s?.diagnosis); setErr('');
  }, [q.data]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setF({ ...f, [k]: e.target.value }); setSaved(false); };
  const save = async () => {
    setBusy('save'); setErr('');
    try { await put(`/api/admissions/${admissionId}/discharge-summary`, { ...f, follow_up_appointment_id: q.data?.summary?.follow_up_appointment_id ?? null }); toast('Discharge summary saved'); setSaved(true); q.reload(); } catch (x) { setErr(errMsg(x)); }
    setBusy('');
  };
  const book = async () => {
    setBusy('book'); setErr('');
    try { await post(`/api/admissions/${admissionId}/follow-up`, { scheduled_at: `${fuDate}T${fuTime}` }); toast('Follow-up appointment booked'); q.reload(); } catch (x) { setErr(errMsg(x)); }
    setBusy('');
  };
  const adm = q.data?.admission;
  const s: Summary | null = q.data?.summary ?? null;
  return (
    <Modal open={admissionId !== null} onClose={onClose} title="Discharge summary" wide>
      {q.loading && !q.data ? <Spinner /> : q.error ? <Alert>{q.error}</Alert> : adm && (
        <div className="space-y-3">
          <p className="text-sm">{adm.first_name} {adm.last_name} ({adm.mrn}) - {adm.ward}, bed {adm.bed} - attending {adm.doctor} <StatusBadge status={adm.status} /></p>
          {err && <Alert>{err}</Alert>}
          {canWrite ? (
            <>
              <TextField label="Diagnosis" required maxLength={500} value={f.diagnosis} onChange={set('diagnosis')} hint={q.data.suggestions.diagnosis ? 'Pre-filled from the latest signed consultation' : undefined} />
              <TextArea label="Hospital course" maxLength={4000} rows={4} value={f.hospital_course} onChange={set('hospital_course')} />
              <TextArea label="Medications on discharge" maxLength={2000} rows={3} value={f.discharge_medications} onChange={set('discharge_medications')} hint="Pre-filled from active prescriptions; edit as needed" />
              <TextArea label="Instructions for the patient" maxLength={2000} rows={3} value={f.instructions} onChange={set('instructions')} />
            </>
          ) : (
            <dl className="space-y-2 text-sm">{[['Diagnosis', s?.diagnosis], ['Hospital course', s?.hospital_course], ['Medications on discharge', s?.discharge_medications], ['Instructions', s?.instructions]].map(([k, v]) => <div key={k as string}><dt className="text-xs font-medium text-muted">{k}</dt><dd className="whitespace-pre-wrap">{v || '-'}</dd></div>)}</dl>
          )}
          <div className="rounded-md border border-line p-3">
            <h3 className="mb-1 text-sm font-semibold">Follow-up appointment</h3>
            {s?.follow_up_at ? <p className="text-sm">{fmtDateTime(s.follow_up_at)} with {s.follow_up_doctor}</p> : <p className="text-sm text-muted">None booked yet.</p>}
            {canWrite && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <TextField label="Date" type="date" min={todayPlus(0)} value={fuDate} onChange={(e) => setFuDate(e.target.value)} />
                <TextField label="Time" type="time" value={fuTime} onChange={(e) => setFuTime(e.target.value)} />
                <Button variant="secondary" loading={busy === 'book'} disabled={!fuDate || !fuTime} onClick={book}><CalendarPlus className="h-4 w-4" />{s?.follow_up_at ? 'Rebook with ' : 'Book with '}{adm.doctor}</Button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {canWrite && <Button loading={busy === 'save'} disabled={f.diagnosis.trim().length < 2} onClick={save}>Save summary</Button>}
            {s?.diagnosis && saved && <a href={`/api/admissions/${admissionId}/discharge-summary/pdf`} className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-sm font-medium hover:bg-surface2"><Download className="h-4 w-4" aria-hidden />Download PDF</a>}
            {s?.diagnosis && !saved && canWrite && <span className="self-center text-xs text-muted">Save your changes to refresh the PDF</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}
