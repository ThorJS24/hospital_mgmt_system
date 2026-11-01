import { useState, type FormEvent } from 'react';
import { FlaskConical } from 'lucide-react';
import { get, post, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Alert, Button, Card, StatusBadge, TextField, errMsg } from '../ui';

/**
 * Legacy / integration tools surfaced in the UI ONLY when the backend runs in vulnerable lab mode.
 * Each tool calls an intentionally weak /api/lab route (see assessment manifest). They look like ordinary hospital utilities.
 */
export const useLabMode = () => useAuth().lab.mode === 'vulnerable';

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card title={<span className="inline-flex items-center gap-2"><FlaskConical className="h-4 w-4 text-warn" aria-hidden />{title}<StatusBadge status="Lab build" tone="warn" /></span>}>{children}</Card>
);

export function LegacyPatientSearch() {
  const [q, setQ] = useState(''); const [res, setRes] = useState<any[] | null>(null); const [err, setErr] = useState('');
  const [mrn, setMrn] = useState(''); const [exists, setExists] = useState<boolean | null>(null);
  const run = async (e: FormEvent) => { e.preventDefault(); setErr(''); try { setRes((await get(`/api/lab/patients/legacy-search${qs({ q })}`)).data); } catch (x) { setRes(null); setErr(errMsg(x)); } };
  const check = async (e: FormEvent) => { e.preventDefault(); setExists((await get(`/api/lab/patients/exists${qs({ mrn })}`)).exists); };
  return (
    <Panel title="Legacy registry tools">
      <div className="grid gap-4 md:grid-cols-2">
        <form onSubmit={run} className="space-y-2"><TextField label="Legacy surname search" value={q} onChange={(e) => setQ(e.target.value)} hint="Old registry lookup (HMS-V01)" /><Button type="submit" variant="secondary">Search</Button>
          {err && <Alert>{err}</Alert>}
          {res && <p className="text-sm text-muted">{res.length} match(es){res.slice(0, 5).map((p) => <span key={p.id} className="block text-ink">{p.mrn} · {p.last_name}, {p.first_name}</span>)}</p>}</form>
        <form onSubmit={check} className="space-y-2"><TextField label="Check MRN exists" value={mrn} onChange={(e) => setMrn(e.target.value)} hint="Duplicate-registration check (HMS-V16)" /><Button type="submit" variant="secondary">Check</Button>
          {exists !== null && <p className="text-sm">{exists ? 'A record with this MRN exists.' : 'No record found.'}</p>}</form>
      </div>
    </Panel>
  );
}

export function MonographFetch() {
  const [url, setUrl] = useState('http://127.0.0.1:4100/internal/metadata'); const [out, setOut] = useState(''); const [err, setErr] = useState('');
  const run = async (e: FormEvent) => { e.preventDefault(); setErr(''); setOut(''); try { const r = await get(`/api/lab/integrations/fetch${qs({ url })}`); setOut(`HTTP ${r.status}\n${r.body}`); } catch (x) { setErr(errMsg(x)); } };
  return (
    <Panel title="Drug monograph fetch (integration, HMS-V13)">
      <form onSubmit={run} className="space-y-2"><TextField label="Monograph URL" value={url} onChange={(e) => setUrl(e.target.value)} /><Button type="submit" variant="secondary">Fetch</Button></form>
      {err && <div className="mt-2"><Alert>{err}</Alert></div>}{out && <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface2 p-2 text-xs">{out}</pre>}
    </Panel>
  );
}

export function MedicationLookup() {
  const [id, setId] = useState(''); const [out, setOut] = useState('');
  const run = async (e: FormEvent) => { e.preventDefault(); try { setOut(JSON.stringify(await get(`/api/lab/pharmacy/medications/${encodeURIComponent(id)}`), null, 2)); } catch (x: any) { setOut(`${x.message}`); } };
  return (
    <Panel title="Medication lookup by ID (HMS-V10)"><form onSubmit={run} className="space-y-2"><TextField label="Medication ID" value={id} onChange={(e) => setId(e.target.value)} /><Button type="submit" variant="secondary">Look up</Button></form>{out && <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface2 p-2 text-xs">{out}</pre>}</Panel>
  );
}

export function ReportDownload() {
  const [file, setFile] = useState('lab-handbook.txt'); const [out, setOut] = useState(''); const [err, setErr] = useState('');
  const run = async (e: FormEvent) => { e.preventDefault(); setErr(''); setOut(''); try { setOut(await get(`/api/lab/reports/download${qs({ file })}`)); } catch (x) { setErr(errMsg(x)); } };
  return (
    <Panel title="Laboratory document download (HMS-V12)"><form onSubmit={run} className="space-y-2"><TextField label="File name" value={file} onChange={(e) => setFile(e.target.value)} hint="Files: lab-handbook.txt, reference-ranges.txt" /><Button type="submit" variant="secondary">Download</Button></form>
      {err && <div className="mt-2"><Alert>{err}</Alert></div>}{out && <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface2 p-2 text-xs">{out}</pre>}</Panel>
  );
}

export function ApiTokenCard() {
  const [tok, setTok] = useState(''); const [out, setOut] = useState('');
  return (
    <Panel title="Integration API token (HMS-V15)">
      <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={async () => setTok((await post('/api/lab/api-token')).token)}>Generate token</Button>
        <Button variant="secondary" disabled={!tok} onClick={async () => { const r = await fetch('/api/lab/token-admin/summary', { headers: { Authorization: `Bearer ${tok}` } }); setOut(`HTTP ${r.status}\n${await r.text()}`); }}>Test against admin summary</Button></div>
      {tok && <p className="mt-2 break-all rounded bg-surface2 p-2 font-mono text-xs">{tok}</p>}{out && <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface2 p-2 text-xs">{out}</pre>}
    </Panel>
  );
}

export function AuditExport() {
  const [out, setOut] = useState('');
  return <Panel title="Quick audit export (HMS-V04)"><Button variant="secondary" onClick={async () => { try { setOut(JSON.stringify((await get('/api/lab/admin/audit-export')).data.slice(0, 5), null, 2)); } catch (x) { setOut(errMsg(x)); } }}>Export latest events</Button>{out && <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface2 p-2 text-xs">{out}</pre>}</Panel>;
}
