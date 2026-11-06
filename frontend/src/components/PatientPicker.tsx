import { useState } from 'react';
import { get } from '../lib/api';
import { SelectField, TextField, useAsync } from './ui';

/** Type-ahead patient selector built on the scoped /api/patients list (so it only offers patients the user may open). */
export function PatientPicker({ value, onChange, label = 'Patient', required = true, error }: { value: string; onChange: (id: string) => void; label?: string; required?: boolean; error?: string }) {
  const [q, setQ] = useState('');
  const found = useAsync(() => (q.trim().length >= 2 ? get(`/api/patients?q=${encodeURIComponent(q.trim())}&pageSize=8`) : Promise.resolve({ data: [] })), [q]);
  const rows: { id: number; first_name: string; last_name: string; mrn: string }[] = found.data?.data ?? [];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label={`Find ${label.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} hint="Type at least 2 letters of the name or MRN" />
      <SelectField label={label} required={required} value={value} onChange={(e) => onChange(e.target.value)} error={error}>
        <option value="">{rows.length ? 'Select...' : q.trim().length >= 2 && !found.loading ? 'No match' : 'Search first'}</option>
        {rows.map((p) => <option key={p.id} value={p.id}>{p.last_name}, {p.first_name} ({p.mrn})</option>)}
      </SelectField>
    </div>
  );
}
