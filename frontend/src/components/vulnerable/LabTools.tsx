import { useState, type FormEvent } from 'react';
import { FlaskConical } from 'lucide-react';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Card, StatusBadge, TextField } from '../ui';

/**
 * Legacy / integration tools surfaced in the UI ONLY when the backend runs in vulnerable lab mode.
 * Each tool calls an intentionally weak /api/lab route (see assessment manifest). They look like ordinary hospital utilities.
 */
export const useLabMode = () => useAuth().lab.mode === 'vulnerable';

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card title={<span className="inline-flex items-center gap-2"><FlaskConical className="h-4 w-4 text-warn" aria-hidden />{title}<StatusBadge status="Lab build" tone="warn" /></span>}>{children}</Card>
);

export function MedicationLookup() {
  const [id, setId] = useState(''); const [out, setOut] = useState('');
  const run = async (e: FormEvent) => { e.preventDefault(); try { setOut(JSON.stringify(await get(`/api/lab/pharmacy/medications/${encodeURIComponent(id)}`), null, 2)); } catch (x: any) { setOut(`${x.message}`); } };
  return (
    <Panel title="Medication lookup by ID (HMS-V10)"><form onSubmit={run} className="space-y-2"><TextField label="Medication ID" value={id} onChange={(e) => setId(e.target.value)} /><Button type="submit" variant="secondary">Look up</Button></form>{out && <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface2 p-2 text-xs">{out}</pre>}</Panel>
  );
}
