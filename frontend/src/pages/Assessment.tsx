import { useRef, useState, type FormEvent } from 'react';
import { Download, FilePlus2 } from 'lucide-react';
import { get, patch, post, fmtDateTime, toBase64 } from '../lib/api';
import { Alert, Button, Card, DataTable, EmptyState, KV, Modal, PageHeader, SelectField, Spinner, StatusBadge, Tabs, TextArea, TextField, Toolbar, errMsg, fieldErrors, useAsync, useList, useToast, type Column } from '../components/ui';

const NEXT: Record<string, string[]> = {
  Planned: ['Not Tested', 'Under Assessment'], 'Not Tested': ['Under Assessment'], 'Under Assessment': ['Confirmed', 'False Positive', 'Not Reproduced'],
  Confirmed: ['Remediation Proposed'], 'False Positive': ['Under Assessment'], 'Not Reproduced': ['Under Assessment'],
  'Remediation Proposed': ['Remediated'], Remediated: ['Retest Passed', 'Retest Failed'], 'Retest Passed': [], 'Retest Failed': ['Remediation Proposed'],
};
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational'];

export default function Assessment() {
  const [tab, setTab] = useState('overview');
  return (
    <div>
      <PageHeader title="Security assessment" subtitle="Assessment register for the MediCore academic lab. Metrics are calculated from stored records." />
      <Alert tone="warn">Registered weaknesses are <strong>intended</strong> and unverified until you record evidence or an explicit decision. Evidence may contain sensitive information — credentials, cookies and tokens are redacted on entry, but always review before sharing.</Alert>
      <div className="mt-3"><Tabs tabs={[{ id: 'overview', label: 'Overview' }, { id: 'tests', label: 'Test cases' }, { id: 'findings', label: 'Findings' }, { id: 'evidence', label: 'Evidence' }, { id: 'reports', label: 'Reports & export' }]} value={tab} onChange={setTab} /></div>
      <div className="mt-4">{tab === 'overview' ? <Overview /> : tab === 'tests' ? <TestCases /> : tab === 'findings' ? <Findings /> : tab === 'evidence' ? <Evidence /> : <Reports />}</div>
    </div>
  );
}

const Stat = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
  <div className="card-shadow rounded-xl border border-line bg-surface p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p><p className="mt-1 text-3xl tracking-tight font-semibold">{value}</p>{sub && <p className="text-xs text-muted">{sub}</p>}</div>
);
const Bar = ({ pct }: { pct: number }) => <div className="h-2 w-full rounded bg-surface2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-2 rounded bg-primary" style={{ width: `${pct}%` }} /></div>;

function Overview() {
  const { data: d, loading, error } = useAsync(() => get('/api/assessment/dashboard'), []);
  if (loading) return <Spinner />;
  if (error || !d) return <Alert>{error}</Alert>;
  const c = d.coverage;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Intended findings" value={d.totalIntended} /><Stat label="Assessed" value={d.assessed} /><Stat label="Confirmed" value={d.confirmed} />
        <Stat label="Not reproduced" value={d.notReproduced} /><Stat label="Awaiting verification" value={d.awaitingVerification} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Intended vulnerability coverage"><p className="mb-1 text-2xl font-semibold">{c.intendedVulnerabilityCoverage.percent}%</p><Bar pct={c.intendedVulnerabilityCoverage.percent} /><p className="mt-1 text-xs text-muted">{c.intendedVulnerabilityCoverage.registered} of {c.intendedVulnerabilityCoverage.manifest} manifest entries registered. This is not proof they exist in the running build.</p></Card>
        <Card title="Assessment verification coverage"><p className="mb-1 text-2xl font-semibold">{c.assessmentVerificationCoverage.percent}%</p><Bar pct={c.assessmentVerificationCoverage.percent} /><p className="mt-1 text-xs text-muted">{c.assessmentVerificationCoverage.decided} of {c.assessmentVerificationCoverage.total} decided (confirmed, not reproduced or false positive).</p></Card>
        <Card title="Test case execution"><p className="mb-1 text-2xl font-semibold">{c.testCaseExecution.percent}%</p><Bar pct={c.testCaseExecution.percent} /><p className="mt-1 text-xs text-muted">{c.testCaseExecution.executed} of {c.testCaseExecution.total} test cases have a recorded result.</p></Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="By severity"><ul className="space-y-1.5">{Object.entries(d.bySeverity).map(([k, v]) => <li key={k} className="flex justify-between"><StatusBadge status={k} tone={k === 'Pending' ? 'neutral' : undefined} /><strong>{v as number}</strong></li>)}</ul></Card>
        <Card title="By category"><ul className="space-y-1.5">{Object.entries(d.byCategory).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><strong>{v as number}</strong></li>)}</ul></Card>
        <Card title="Evidence, remediation, retest">
          <dl className="grid grid-cols-2 gap-3"><KV label="Evidence completeness">{d.evidenceCompleteness.percent}% ({d.evidenceCompleteness.withEvidence}/{d.evidenceCompleteness.confirmedFindings})</KV><KV label="Remediation records">{Object.values(d.remediation as Record<string, number>).reduce((a, b) => a + b, 0)}</KV><KV label="Retest passed">{d.retest.passed}</KV><KV label="Retest failed">{d.retest.failed}</KV></dl>
        </Card>
      </div>
    </div>
  );
}

function TestCases() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get('/api/assessment/test-cases'), []);
  const [rec, setRec] = useState<any | null>(null);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  return (
    <Card title="Assessment test cases">
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only-live">Test cases</caption><thead className="text-xs uppercase text-muted"><tr><th className="px-2 py-1">ID</th><th>Name</th><th>Kind</th><th>Account</th><th>Finding</th><th>Latest result</th><th /></tr></thead>
        <tbody>{data.data.map((t: any) => { const last = t.results?.[0]; return (
          <tr key={t.id} className="border-t border-line align-top"><td className="px-2 py-1.5 whitespace-nowrap font-medium">{t.id}</td><td>{t.name}<p className="text-xs text-muted">{t.objective}</p></td>
            <td><StatusBadge status={t.kind === 'expected-vulnerability' ? 'Expected vulnerability' : 'Security control'} tone={t.kind === 'expected-vulnerability' ? 'warn' : 'info'} /></td><td>{t.test_account}</td><td>{t.finding_id ?? '—'}</td>
            <td>{last ? <StatusBadge status={last.status} /> : <span className="text-muted">Not executed</span>}</td><td className="text-right"><Button variant="secondary" onClick={() => setRec(t)}>Record result</Button></td></tr>); })}</tbody></table></div>
      <ResultDialog tc={rec} onClose={() => setRec(null)} onDone={() => { setRec(null); reload(); toast('Result recorded'); }} />
    </Card>
  );
}

function ResultDialog({ tc, onClose, onDone }: { tc: any | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ status: '', actual_result: '', notes: '', evidence_id: '' });
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const ev = useAsync(() => (tc?.finding_id ? get(`/api/assessment/evidence?finding_id=${tc.finding_id}`) : Promise.resolve({ data: [] })), [tc?.id]);
  const opts = tc?.kind === 'expected-vulnerability' ? [['reproduced', 'Weakness reproduced'], ['not-reproduced', 'Not reproduced']] : [['pass', 'Control passed'], ['fail', 'Control failed']];
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    try { await post(`/api/assessment/test-cases/${tc.id}/results`, { ...f, evidence_id: f.evidence_id || undefined }); setF({ status: '', actual_result: '', notes: '', evidence_id: '' }); onDone(); } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!tc} onClose={onClose} title={tc ? `Record result: ${tc.id}` : ''}>
      {tc && <form onSubmit={submit} className="space-y-3" noValidate>
        <p className="text-muted">Expected: {tc.expected_result}</p>
        {tc.kind === 'expected-vulnerability' && <Alert tone="info">“Reproduced” records that the intended weakness was observed. It does not mean a security control passed.</Alert>}
        {err && <Alert>{err}</Alert>}
        <SelectField label="Outcome" required value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} error={fe.status}><option value="">Select…</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField>
        <TextArea label="Actual result" required value={f.actual_result} onChange={(e) => setF({ ...f, actual_result: e.target.value })} error={fe.actual_result} />
        <TextArea label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        <SelectField label="Evidence" value={f.evidence_id} onChange={(e) => setF({ ...f, evidence_id: e.target.value })} hint={tc.finding_id ? 'Evidence already recorded for this finding' : 'Control test cases have no linked finding'}><option value="">None</option>{(ev.data?.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.id} · {x.evidence_type} · {x.route}</option>)}</SelectField>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save result</Button></div>
      </form>}
    </Modal>
  );
}

interface F { id: string; title: string; category: string; origin: string; status: string; severity: string | null; cvss_score: number | null; evidence_count: number; affected_route: string }
function Findings() {
  const toast = useToast();
  const list = useList<F>('/api/assessment/findings');
  const [sel, setSel] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const cols: Column<F>[] = [
    { key: 'id', label: 'ID' }, { key: 'title', label: 'Title' }, { key: 'category', label: 'Category' }, { key: 'origin', label: 'Origin' },
    { key: 'severity', label: 'Severity', render: (r) => <StatusBadge status={r.severity ?? 'Pending'} tone={r.severity ? undefined : 'neutral'} /> },
    { key: 'cvss', label: 'CVSS 4.0', render: (r) => r.cvss_score ?? 'Pending' },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { key: 'evidence_count', label: 'Evidence' },
  ];
  return (
    <Card title="Findings register" actions={<Button variant="secondary" onClick={() => setCreate(true)}><FilePlus2 className="h-4 w-4" />Add additional finding</Button>}>
      <Toolbar list={list} placeholder="Filter shown findings">
        <SelectField label="Status" value={list.state.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}><option value="">All</option>{Object.keys(NEXT).map((s) => <option key={s}>{s}</option>)}</SelectField>
        <SelectField label="Origin" value={list.state.filters.origin ?? ''} onChange={(e) => list.setFilter('origin', e.target.value)}><option value="">All</option><option>intended</option><option>accidental</option><option>third-party</option><option>scanner</option></SelectField>
      </Toolbar>
      <DataTable list={{ ...list, rows: list.rows.filter((r) => !list.state.q || `${r.id} ${r.title} ${r.category}`.toLowerCase().includes(list.state.q.toLowerCase())) }} columns={cols} caption="Findings" onRowClick={(r) => setSel(r.id)} />
      <FindingDialog id={sel} onClose={() => { setSel(null); list.reload(); }} />
      <CreateFinding open={create} onClose={() => setCreate(false)} onDone={() => { setCreate(false); list.reload(); toast('Finding created'); }} />
    </Card>
  );
}

function CreateFinding({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ id: '', origin: 'accidental', title: '', category: '', affected_route: '', description: '' });
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(''); setFe({}); try { await post('/api/assessment/findings', f); onDone(); } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); } setBusy(false); };
  return (
    <Modal open={open} onClose={onClose} title="Add additional finding">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <p className="text-muted">For accidental defects, third-party issues or scanner results. Intended weaknesses come from the manifest.</p>
        {err && <Alert>{err}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2"><TextField label="Finding ID" required value={f.id} onChange={set('id')} hint="e.g. HMS-A01" error={fe.id} /><SelectField label="Origin" value={f.origin} onChange={set('origin')}><option value="accidental">Accidental defect</option><option value="third-party">Third-party dependency</option><option value="scanner">Scanner result (unverified)</option></SelectField></div>
        <TextField label="Title" required value={f.title} onChange={set('title')} error={fe.title} />
        <TextField label="Category" required value={f.category} onChange={set('category')} error={fe.category} />
        <TextField label="Affected route" value={f.affected_route} onChange={set('affected_route')} />
        <TextArea label="Description" value={f.description} onChange={set('description')} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create</Button></div>
      </form>
    </Modal>
  );
}

function FindingDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const { data: f, loading, error, reload } = useAsync(() => (id ? get(`/api/assessment/findings/${id}`) : Promise.resolve(null)), [id]);
  const [tab, setTab] = useState('details');
  const [note, setNote] = useState(''); const [err, setErr] = useState('');
  const transition = async (to: string) => {
    setErr('');
    try {
      if (to === 'Remediation Proposed' || to === 'Remediated' || to === 'Retest Passed' || to === 'Retest Failed') {
        const status = ({ 'Remediation Proposed': 'Proposed', Remediated: 'Implemented', 'Retest Passed': 'Retest Passed', 'Retest Failed': 'Retest Failed' } as Record<string, string>)[to];
        await post(`/api/assessment/findings/${id}/remediation`, { status, notes: note || `Status set to ${to}` });
      } else await post(`/api/assessment/findings/${id}/transition`, { to, note });
      setNote(''); toast(`Status: ${to}`); reload();
    } catch (x) { setErr(errMsg(x)); }
  };
  return (
    <Modal open={id !== null} onClose={onClose} title={f ? `${f.id} — ${f.title}` : 'Finding'} wide>
      {loading && !f ? <Spinner /> : error ? <Alert>{error}</Alert> : f && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge status={f.status} /><StatusBadge status={f.severity ?? 'Pending'} tone={f.severity ? undefined : 'neutral'} /><span className="text-muted">{f.category} · {f.origin} · {f.affected_route}</span></div>
          {f.status === 'Not Tested' && <Alert tone="warn">Not tested: this is an intended weakness from the manifest and is not a confirmed vulnerability.</Alert>}
          {err && <Alert>{err}</Alert>}
          {NEXT[f.status]?.length > 0 && (
            <div className="rounded-md border border-line p-3">
              <TextArea label="Decision note / justification" value={note} onChange={(e) => setNote(e.target.value)} hint="Required for Confirmed (without evidence), Not Reproduced and False Positive" />
              <div className="mt-2 flex flex-wrap gap-2">{NEXT[f.status].map((s) => <Button key={s} variant="secondary" onClick={() => void transition(s)}>Mark: {s}</Button>)}</div>
            </div>
          )}
          <Tabs tabs={[{ id: 'details', label: 'Assessment' }, { id: 'evidence', label: `Evidence (${f.evidence.length})` }, { id: 'manifest', label: 'Manifest' }, { id: 'history', label: 'History' }]} value={tab} onChange={setTab} />
          {tab === 'details' && <Details f={f} onSaved={() => { toast('Finding saved'); reload(); }} />}
          {tab === 'evidence' && <EvidenceTab f={f} reload={reload} />}
          {tab === 'manifest' && (f.manifest ? <dl className="grid gap-3 sm:grid-cols-2"><KV label="CWE">{f.manifest.cwe}</KV><KV label="OWASP">{f.manifest.owasp_category}</KV><KV label="Component">{f.manifest.affected_component}</KV><KV label="Route">{f.manifest.affected_route}</KV><KV label="Intended weakness">{f.manifest.intended_weakness}</KV><KV label="Expected observation">{f.manifest.expected_observation}</KV><KV label="Assessment method">{f.manifest.assessment_method}</KV><KV label="Evidence requirements">{f.manifest.evidence_requirements}</KV><KV label="Severity rationale">{f.manifest.severity_rationale}</KV><KV label="Remediation">{f.manifest.remediation}</KV><KV label="Test cases">{f.test_cases.map((t: any) => t.id).join(', ') || '—'}</KV></dl> : <EmptyState title="Not part of the intended manifest" />)}
          {tab === 'history' && (f.history.length ? <ul className="divide-y divide-line">{f.history.map((h: any) => <li key={h.id} className="py-1.5"><strong>{h.from_status ?? '—'} → {h.to_status}</strong> <span className="text-muted">by {h.username ?? 'unknown'} · {fmtDateTime(h.at)}</span>{h.note && <p>{h.note}</p>}</li>)}</ul> : <EmptyState title="No status changes yet" />)}
        </div>
      )}
    </Modal>
  );
}

const FIELDS: [string, string, boolean][] = [['description', 'Description', true], ['technical_details', 'Technical details', true], ['verification_steps', 'Reproduction / verification procedure', true], ['expected_behavior', 'Expected behavior', true], ['observed_behavior', 'Observed behavior', true], ['impact', 'Impact', true], ['root_cause', 'Root cause', true], ['remediation', 'Remediation recommendation', true], ['refs', 'References', false]];
function Details({ f, onSaved }: { f: any; onSaved: () => void }) {
  const init = () => ({ severity: f.severity ?? '', cvss_score: f.cvss_score ?? '', cvss_vector: f.cvss_vector ?? '', confidence: f.confidence ?? '', likelihood: f.likelihood ?? '', business_impact: f.business_impact ?? '', ...Object.fromEntries(FIELDS.map(([k]) => [k, f[k] ?? ''])) } as Record<string, any>);
  const [v, setV] = useState(init);
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    const body: Record<string, unknown> = { ...v, severity: v.severity || null, confidence: v.confidence || null, likelihood: v.likelihood || null, business_impact: v.business_impact || null, cvss_score: v.cvss_score === '' ? null : Number(v.cvss_score), cvss_vector: v.cvss_vector || null };
    try { await patch(`/api/assessment/findings/${f.id}`, body); onSaved(); } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  const set = (k: string) => (e: React.ChangeEvent<any>) => setV({ ...v, [k]: e.target.value });
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      {err && <Alert>{err}</Alert>}
      <p className="text-xs text-muted">Leave severity and CVSS empty (“Pending assessment”) unless the score can be justified from recorded evidence. CVSS v4.0 base vector required with a score; severity must match the score band.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label="Severity" value={v.severity} onChange={set('severity')} error={fe.severity}><option value="">Pending assessment</option>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</SelectField>
        <TextField label="CVSS v4.0 base score" type="number" step="0.1" min={0} max={10} value={v.cvss_score} onChange={set('cvss_score')} error={fe.cvss_score} />
        <SelectField label="Confidence" value={v.confidence} onChange={set('confidence')}><option value="">Not set</option><option>High</option><option>Medium</option><option>Low</option></SelectField>
      </div>
      <TextField label="CVSS v4.0 vector" value={v.cvss_vector} onChange={set('cvss_vector')} hint="CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N" error={fe.cvss_vector} />
      <div className="grid gap-3 sm:grid-cols-2"><TextField label="Likelihood" value={v.likelihood} onChange={set('likelihood')} /><TextField label="Business impact" value={v.business_impact} onChange={set('business_impact')} /></div>
      {FIELDS.map(([k, label, multi]) => multi ? <TextArea key={k} label={label} value={v[k]} onChange={set(k)} error={fe[k]} /> : <TextField key={k} label={label} value={v[k]} onChange={set(k)} error={fe[k]} />)}
      <div className="flex items-center justify-between"><span className="text-xs text-muted">Last updated {fmtDateTime(f.updated_at)}</span><Button type="submit" loading={busy}>Save finding</Button></div>
    </form>
  );
}

function EvidenceTab({ f, reload }: { f: any; reload: () => void }) {
  const toast = useToast(); const file = useRef<HTMLInputElement>(null);
  const [v, setV] = useState({ evidence_type: 'http-exchange', route: f.affected_route ?? '', http_method: 'GET', http_status: '', request_meta: '', response_meta: '', notes: '', screenshot_ref: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<any>) => setV({ ...v, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const fl = file.current?.files?.[0];
      const body: Record<string, unknown> = { ...v, finding_id: f.id, http_status: v.http_status ? Number(v.http_status) : undefined, http_method: v.evidence_type === 'http-exchange' ? v.http_method : undefined };
      if (fl) { if (fl.size > 1024 * 1024) throw new Error('Evidence file exceeds 1 MB'); body.file_name = fl.name; body.content_base64 = toBase64(await fl.arrayBuffer()); }
      await post('/api/assessment/evidence', body); toast('Evidence recorded'); setV({ ...v, request_meta: '', response_meta: '', notes: '', screenshot_ref: '' }); if (file.current) file.current.value = ''; reload();
    } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <div className="space-y-4">
      {f.evidence.length ? <ul className="divide-y divide-line">{f.evidence.map((e: any) => <li key={e.id} className="py-2"><strong>{e.id}</strong> · {e.evidence_type} · {e.http_method} {e.route} {e.http_status ?? ''} <span className="text-muted">· {fmtDateTime(e.collected_at)}</span>{e.notes && <p>{e.notes}</p>}{e.sha256 && <p className="break-all text-xs text-muted">sha256: {e.sha256}</p>}</li>)}</ul> : <EmptyState title="No evidence recorded" hint="Confirming a finding requires evidence or an explicit decision note." />}
      <form onSubmit={submit} className="space-y-3 border-t border-line pt-3" noValidate>
        <h3 className="font-semibold">Add evidence</h3>
        <Alert tone="warn">Do not paste real credentials, session tokens or patient data. Known secret patterns are redacted automatically, but you are responsible for the content.</Alert>
        {err && <Alert>{err}</Alert>}
        <div className="grid gap-3 sm:grid-cols-4">
          <SelectField label="Type" value={v.evidence_type} onChange={set('evidence_type')}>{['http-exchange', 'screenshot', 'scanner-output', 'log-excerpt', 'note'].map((t) => <option key={t}>{t}</option>)}</SelectField>
          <SelectField label="Method" value={v.http_method} onChange={set('http_method')}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((t) => <option key={t}>{t}</option>)}</SelectField>
          <TextField label="HTTP status" type="number" min={100} max={599} value={v.http_status} onChange={set('http_status')} />
          <TextField label="Route" value={v.route} onChange={set('route')} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2"><TextArea label="Sanitised request metadata" value={v.request_meta} onChange={set('request_meta')} /><TextArea label="Sanitised response metadata" value={v.response_meta} onChange={set('response_meta')} /></div>
        <div className="grid gap-3 sm:grid-cols-2"><TextField label="Screenshot reference" value={v.screenshot_ref} onChange={set('screenshot_ref')} hint="File name or note — not uploaded" /><div className="flex flex-col gap-1"><label htmlFor="ev-file" className="text-xs font-medium text-muted">Evidence file (txt, json, md, log, csv, png; max 1 MB)</label><input id="ev-file" ref={file} type="file" accept=".txt,.json,.md,.log,.csv,.png" className="text-sm" /></div></div>
        <TextArea label="Notes" value={v.notes} onChange={set('notes')} />
        <Button type="submit" loading={busy}>Save evidence</Button>
      </form>
    </div>
  );
}

function Evidence() {
  const { data, loading, error } = useAsync(() => get('/api/assessment/evidence'), []);
  if (loading) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  return (
    <Card title="Evidence register">
      <Alert tone="warn">{data.warning}</Alert>
      {data.data.length === 0 ? <EmptyState title="No evidence recorded yet" /> : <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only-live">Evidence</caption><thead className="text-xs uppercase text-muted"><tr><th className="px-2 py-1">ID</th><th>Finding</th><th>Type</th><th>Route</th><th>Status</th><th>Collected</th><th>SHA-256</th></tr></thead><tbody>{data.data.map((e: any) => <tr key={e.id} className="border-t border-line"><td className="px-2 py-1.5">{e.id}</td><td>{e.finding_id}</td><td>{e.evidence_type}</td><td>{e.http_method} {e.route}</td><td>{e.http_status ?? '—'}</td><td>{fmtDateTime(e.collected_at)}</td><td className="max-w-40 truncate" title={e.sha256 ?? ''}>{e.sha256 ? e.sha256.slice(0, 16) + '…' : '—'}</td></tr>)}</tbody></table></div>}
    </Card>
  );
}

function Reports() {
  const toast = useToast();
  const { data, reload } = useAsync(() => get('/api/assessment/reports'), []);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const gen = async (format: string) => { setBusy(true); setErr(''); try { const r = await post('/api/assessment/reports', { format }); toast(`Generated ${r.filename}`); reload(); } catch (x) { setErr(errMsg(x)); } setBusy(false); };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Export vulnerability register">
        <p className="mb-3 text-muted">Exports reflect the saved assessment records at the time of download.</p>
        <div className="flex gap-2"><a className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface2" href="/api/assessment/export/register.csv"><Download className="h-4 w-4" />CSV</a><a className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface2" href="/api/assessment/export/register.json"><Download className="h-4 w-4" />JSON</a></div>
      </Card>
      <Card title="Generate assessment report">
        {err && <Alert>{err}</Alert>}
        <div className="flex flex-wrap gap-2"><Button loading={busy} onClick={() => void gen('html')}>HTML report</Button><Button variant="secondary" loading={busy} onClick={() => void gen('json')}>JSON</Button><Button variant="secondary" loading={busy} onClick={() => void gen('csv')}>CSV register</Button></div>
        <h3 className="mb-1 mt-4 text-xs font-semibold uppercase text-muted">Generated reports</h3>
        {(data?.data ?? []).length ? <ul className="divide-y divide-line">{data.data.map((f: string) => <li key={f} className="py-1.5"><a className="text-primary hover:underline" href={`/api/assessment/reports/${f}`}>{f}</a></li>)}</ul> : <EmptyState title="No reports generated yet" />}
      </Card>
    </div>
  );
}
