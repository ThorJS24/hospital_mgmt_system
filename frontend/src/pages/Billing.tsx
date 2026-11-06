import { useState, type FormEvent } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { get, post, money, fmtDate, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Alert, Button, DataTable, Modal, PageHeader, SelectField, Spinner, StatusBadge, Tabs, TextArea, TextField, Toolbar, errMsg, useAsync, useList, useToast, type Column } from '../components/ui';

interface Row { id: number; invoice_no: string; status: string; issued_on: string; due_on: string; patient: string; mrn: string; total: number; paid: number; balance: number }
interface Payment { id: number; invoice_id: number; invoice_no: string; patient: string; mrn: string; amount: number; method: string; kind: 'Payment' | 'Refund'; reason: string; paid_at: string }
interface Claim { id: number; invoice_id: number; invoice_no: string; patient: string; mrn: string; provider: string; policy_no: string; amount_claimed: number; amount_approved: number | null; status: string; note: string; submitted_at: string; decided_at: string | null; submitted_by_name: string | null; decided_by_name: string | null }

export default function Billing() {
  const { can } = useAuth(); const toast = useToast();
  const { t } = useT();
  const [tab, setTab] = useState('invoices');
  const list = useList<Row>('/api/invoices', '', 15, { urlQuery: true });
  const payments = useList<Payment>('/api/payments');
  const claims = useList<Claim>('/api/claims');
  const initial = Number(new URLSearchParams(window.location.search).get('invoice')) || null;
  const [detail, setDetail] = useState<number | null>(initial);
  const [create, setCreate] = useState(false);
  const [decide, setDecide] = useState<Claim | null>(null);
  const cols: Column<Row>[] = [
    { key: 'invoice_no', label: 'Invoice' },
    { key: 'patient', label: 'Patient', render: (r) => <>{r.patient} <span className="text-muted">({r.mrn})</span></> },
    { key: 'issued_on', label: 'Issued', render: (r) => fmtDate(r.issued_on) },
    { key: 'due_on', label: 'Due', render: (r) => fmtDate(r.due_on) },
    { key: 'total', label: 'Total', className: 'text-right', render: (r) => money(r.total) },
    { key: 'balance', label: 'Balance', className: 'text-right', render: (r) => money(r.balance) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];
  const payCols: Column<Payment>[] = [
    { key: 'paid_at', label: 'Date', render: (p) => fmtDateTime(p.paid_at) },
    { key: 'invoice_no', label: 'Invoice', render: (p) => <button className="text-primary hover:underline" onClick={() => setDetail(p.invoice_id)}>{p.invoice_no}</button> },
    { key: 'patient', label: 'Patient', render: (p) => <>{p.patient} <span className="text-muted">({p.mrn})</span></> },
    { key: 'method', label: 'Method', render: (p) => <>{p.method}{p.reason && <span className="block text-xs text-muted">{p.reason}</span>}</> },
    { key: 'kind', label: 'Type', render: (p) => <StatusBadge status={p.kind} tone={p.kind === 'Refund' ? 'warn' : 'ok'} /> },
    { key: 'amount', label: 'Amount', className: 'text-right', render: (p) => <span className={p.amount < 0 ? 'text-danger' : ''}>{money(p.amount)}</span> },
  ];
  const claimCols: Column<Claim>[] = [
    { key: 'invoice_no', label: 'Invoice', render: (c) => <button className="text-primary hover:underline" onClick={() => setDetail(c.invoice_id)}>{c.invoice_no}</button> },
    { key: 'patient', label: 'Patient', render: (c) => <>{c.patient} <span className="text-muted">({c.mrn})</span></> },
    { key: 'provider', label: 'Insurer', render: (c) => <>{c.provider}<span className="block text-xs text-muted">{c.policy_no}</span></> },
    { key: 'amount_claimed', label: 'Claimed', className: 'text-right', render: (c) => money(c.amount_claimed) },
    { key: 'amount_approved', label: 'Approved', className: 'text-right', render: (c) => (c.amount_approved === null ? '-' : money(c.amount_approved)) },
    { key: 'submitted_at', label: 'Submitted', render: (c) => <>{fmtDate(c.submitted_at)}<span className="block text-xs text-muted">{c.submitted_by_name ?? ''}</span></> },
    { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} tone={c.status === 'Submitted' ? 'warn' : c.status === 'Rejected' ? 'danger' : 'ok'} /> },
  ];
  const tabs = [{ id: 'invoices', label: 'Invoices' }, { id: 'payments', label: 'Payments and refunds' }, ...(can('claims.read') ? [{ id: 'claims', label: 'Insurance claims' }] : [])];
  return (
    <div>
      <PageHeader title={t('page.billing')} subtitle="Synthetic invoices - no real payment processing" actions={can('billing.write') ? <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New invoice</Button> : undefined} />
      <div className="card-shadow rounded-xl border border-line bg-surface p-4">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        <div className="mt-3">
          {tab === 'invoices' && <>
            <Toolbar list={list} placeholder="Invoice no., patient or MRN">
              <SelectField label="Status" value={list.state.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}><option value="">All</option>{['Draft', 'Issued', 'Partially paid', 'Paid', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}</SelectField>
              <TextField label="Issued from" type="date" value={list.state.filters.from ?? ''} onChange={(e) => list.setFilter('from', e.target.value)} />
              <TextField label="Issued to" type="date" value={list.state.filters.to ?? ''} onChange={(e) => list.setFilter('to', e.target.value)} />
            </Toolbar>
            <DataTable list={list} columns={cols} caption="Invoices" onRowClick={(r) => setDetail(r.id)} />
          </>}
          {tab === 'payments' && <>
            <Toolbar list={payments} placeholder="Invoice, patient or method">
              <SelectField label="Type" value={payments.state.filters.kind ?? ''} onChange={(e) => payments.setFilter('kind', e.target.value)}><option value="">All</option><option>Payment</option><option>Refund</option></SelectField>
              <TextField label="From" type="date" value={payments.state.filters.from ?? ''} onChange={(e) => payments.setFilter('from', e.target.value)} />
              <TextField label="To" type="date" value={payments.state.filters.to ?? ''} onChange={(e) => payments.setFilter('to', e.target.value)} />
            </Toolbar>
            {payments.data && <p className="mb-2 text-sm text-muted">Net of refunds for this selection: <strong className="text-ink">{money((payments.data as unknown as { net: number }).net)}</strong></p>}
            <DataTable list={payments} columns={payCols} caption="Payment history" />
          </>}
          {tab === 'claims' && <>
            <Toolbar list={claims} placeholder="Invoice, patient or insurer">
              <SelectField label="Status" value={claims.state.filters.status ?? ''} onChange={(e) => claims.setFilter('status', e.target.value)}><option value="">All</option>{['Submitted', 'Approved', 'Partially approved', 'Rejected'].map((s) => <option key={s}>{s}</option>)}</SelectField>
            </Toolbar>
            <DataTable list={claims} columns={claimCols} caption="Insurance claims" empty="No insurance claims" actions={can('claims.decide') ? (c) => (c.status === 'Submitted' ? <Button variant="secondary" onClick={() => setDecide(c)}>Record decision</Button> : null) : undefined} />
          </>}
        </div>
      </div>
      <Detail id={detail} onClose={() => { setDetail(null); list.reload(); payments.reload(); claims.reload(); }} />
      <DecisionDialog claim={decide} onClose={() => setDecide(null)} onDone={() => { setDecide(null); toast('Decision recorded'); claims.reload(); list.reload(); payments.reload(); }} />
      <CreateDialog open={create} onClose={() => setCreate(false)} onDone={() => { setCreate(false); list.reload(); toast('Invoice created'); }} />
    </div>
  );
}

function Detail({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { can } = useAuth(); const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => (id ? get(`/api/invoices/${id}`) : Promise.resolve(null)), [id]);
  const [amount, setAmount] = useState(''); const [err, setErr] = useState('');
  const [refund, setRefund] = useState<{ payment: any } | null>(null);
  const [claimAmt, setClaimAmt] = useState('');
  const pay = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await post(`/api/invoices/${id}/payments`, { amount: Number(amount) }); setAmount(''); toast('Payment recorded'); reload(); } catch (x) { setErr(errMsg(x)); }
  };
  const cancel = async () => { try { await post(`/api/invoices/${id}/cancel`); toast('Invoice cancelled'); reload(); } catch (x) { setErr(errMsg(x)); } };
  const submitClaim = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await post(`/api/invoices/${id}/claims`, { amount_claimed: Number(claimAmt) }); setClaimAmt(''); toast('Claim submitted to the insurer'); reload(); } catch (x) { setErr(errMsg(x)); }
  };
  const open = data?.claims?.find((c: any) => c.status === 'Submitted');
  const refundable = (p: any) => p.kind === 'Payment' && data.payments.filter((r: any) => r.refund_of === p.id).reduce((s: number, r: any) => s + r.amount, p.amount);
  return (
    <Modal open={id !== null} onClose={onClose} title={data?.invoice_no ?? 'Invoice'} wide>
      {loading && !data ? <Spinner /> : error ? <Alert>{error}</Alert> : data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>{data.patient} ({data.mrn}) · issued {fmtDate(data.issued_on)} · due {fmtDate(data.due_on)}</p>
            <span className="flex items-center gap-2"><a href={`/api/invoices/${data.id}/pdf`} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-sm hover:bg-surface2" aria-label={`Download ${data.invoice_no} as PDF`}><Download className="h-3.5 w-3.5" aria-hidden />PDF</a><StatusBadge status={data.status} /></span>
          </div>
          <table className="w-full text-left text-sm"><caption className="sr-only-live">Line items</caption><thead className="text-xs uppercase text-muted"><tr><th className="py-1">Description</th><th className="text-right">Qty</th><th className="text-right">Unit price</th><th className="text-right">Amount</th></tr></thead>
            <tbody>{data.items.map((i: any) => <tr key={i.id} className="border-t border-line"><td className="py-1.5">{i.description}</td><td className="text-right">{i.quantity}</td><td className="text-right">{money(i.unit_price)}</td><td className="text-right">{money(i.line_total)}</td></tr>)}</tbody>
            <tfoot><tr className="border-t border-line font-semibold"><td colSpan={3} className="py-1.5 text-right">Total</td><td className="text-right">{money(data.total)}</td></tr><tr><td colSpan={3} className="text-right">Paid (net of refunds)</td><td className="text-right">{money(data.paid)}</td></tr><tr className="font-semibold"><td colSpan={3} className="text-right">Balance</td><td className="text-right">{money(data.balance)}</td></tr></tfoot></table>
          {data.payments.length > 0 && (
            <div><h3 className="mb-1 font-semibold">Payment history</h3>
              <ul className="divide-y divide-line">{data.payments.map((p: any) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                  <span>{fmtDate(p.paid_at)} · {p.method}{p.reason && <span className="text-muted"> ({p.reason})</span>}</span>
                  <span className="flex items-center gap-2"><span className={p.amount < 0 ? 'text-danger' : ''}>{money(p.amount)}</span>
                    {can('refunds.write') && refundable(p) > 0 && <Button variant="ghost" onClick={() => { setErr(''); setRefund({ payment: p }); }}>Refund</Button>}</span>
                </li>))}</ul></div>
          )}
          {data.claims?.length > 0 && (
            <div><h3 className="mb-1 font-semibold">Insurance claims</h3>
              <ul className="divide-y divide-line">{data.claims.map((c: any) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm"><span>{c.provider}: claimed {money(c.amount_claimed)}{c.amount_approved !== null && `, approved ${money(c.amount_approved)}`}{c.note && <span className="text-muted"> ({c.note})</span>}</span><StatusBadge status={c.status} tone={c.status === 'Submitted' ? 'warn' : c.status === 'Rejected' ? 'danger' : 'ok'} /></li>))}</ul></div>
          )}
          {err && <Alert>{err}</Alert>}
          {can('billing.write') && data.status !== 'Paid' && data.status !== 'Cancelled' && (
            <form onSubmit={pay} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <TextField label="Record payment (USD)" type="number" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button type="submit">Record payment</Button>
              {data.paid === 0 && <Button type="button" variant="danger" onClick={() => void cancel()}>Cancel invoice</Button>}
            </form>
          )}
          {can('claims.write') && ['Issued', 'Partially paid'].includes(data.status) && !open && data.balance > 0 && (
            <form onSubmit={submitClaim} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <TextField label="Insurance claim amount (USD)" type="number" step="0.01" min="0.01" max={data.balance} required value={claimAmt} onChange={(e) => setClaimAmt(e.target.value)} hint={`Up to the balance of ${money(data.balance)}`} />
              <Button type="submit" variant="secondary">Submit claim</Button>
            </form>
          )}
        </div>
      )}
      <RefundDialog target={refund?.payment ?? null} invoiceId={id} onClose={() => setRefund(null)} onDone={() => { setRefund(null); toast('Refund recorded'); reload(); }} />
    </Modal>
  );
}

function RefundDialog({ target, invoiceId, onClose, onDone }: { target: any | null; invoiceId: number | null; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await post(`/api/invoices/${invoiceId}/refunds`, { payment_id: target.id, amount: Number(amount), reason: reason.trim() }); setAmount(''); setReason(''); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!target} onClose={onClose} title="Refund a payment">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        {target && <p className="text-sm">Original payment: {money(target.amount)} on {fmtDate(target.paid_at)} ({target.method})</p>}
        <TextField label="Refund amount (USD)" type="number" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        <TextArea label="Reason" required maxLength={200} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded with your name in the payment history" />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" variant="danger" loading={busy} disabled={!Number(amount) || reason.trim().length < 3}>Refund</Button></div>
      </form>
    </Modal>
  );
}

function DecisionDialog({ claim, onClose, onDone }: { claim: Claim | null; onClose: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState('Approve'); const [amount, setAmount] = useState(''); const [note, setNote] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!claim) return;
    setBusy(true); setErr('');
    try { await post(`/api/claims/${claim.id}/decision`, { decision, note, ...(decision === 'PartiallyApprove' && { amount_approved: Number(amount) }) }); setAmount(''); setNote(''); setDecision('Approve'); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!claim} onClose={onClose} title="Record the insurer's decision">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        {claim && <p className="text-sm">{claim.provider}: {money(claim.amount_claimed)} claimed on {claim.invoice_no} for {claim.patient}.</p>}
        <Alert tone="info">Four-eyes rule: the person who submitted a claim cannot record its decision.</Alert>
        <SelectField label="Decision" value={decision} onChange={(e) => setDecision(e.target.value)}><option value="Approve">Approve in full</option><option value="PartiallyApprove">Approve partially</option><option value="Reject">Reject</option></SelectField>
        {decision === 'PartiallyApprove' && <TextField label="Approved amount (USD)" type="number" step="0.01" min="0.01" max={claim ? claim.amount_claimed - 0.01 : undefined} required value={amount} onChange={(e) => setAmount(e.target.value)} />}
        <TextField label={decision === 'Reject' ? 'Reason for rejection' : 'Note'} required={decision === 'Reject'} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Record decision</Button></div>
      </form>
    </Modal>
  );
}

function CreateDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [patient, setPatient] = useState(''); const [pq, setPq] = useState(''); const [due, setDue] = useState('');
  const [items, setItems] = useState([{ description: '', quantity: '1', unit_price: '' }]);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const pats = useAsync(() => (pq.length >= 2 ? get(`/api/patients?q=${encodeURIComponent(pq)}&pageSize=8`) : Promise.resolve({ data: [] })), [pq]);
  const total = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);
  const upd = (i: number, k: string, v: string) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await post('/api/invoices', { patient_id: Number(patient), due_on: due || undefined, items: items.map((i) => ({ description: i.description, quantity: Number(i.quantity), unit_price: Number(i.unit_price) })) }); setItems([{ description: '', quantity: '1', unit_price: '' }]); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="New invoice" wide>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="Find patient" value={pq} onChange={(e) => setPq(e.target.value)} hint="Type at least 2 letters" />
          <SelectField label="Patient" required value={patient} onChange={(e) => setPatient(e.target.value)}><option value="">Select…</option>{(pats.data?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.last_name}, {p.first_name} ({p.mrn})</option>)}</SelectField>
          <TextField label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} hint="Default: 30 days" />
        </div>
        {items.map((it, i) => (
          <fieldset key={i} className="grid items-end gap-2 rounded-md border border-line p-2 sm:grid-cols-[3fr_6rem_8rem_auto]"><legend className="px-1 text-xs text-muted">Line {i + 1}</legend>
            <TextField label="Description" required value={it.description} onChange={(e) => upd(i, 'description', e.target.value)} />
            <TextField label="Qty" type="number" min={1} required value={it.quantity} onChange={(e) => upd(i, 'quantity', e.target.value)} />
            <TextField label="Unit price" type="number" step="0.01" min={0} required value={it.unit_price} onChange={(e) => upd(i, 'unit_price', e.target.value)} />
            {items.length > 1 && <Button type="button" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
          </fieldset>
        ))}
        <div className="flex items-center justify-between"><Button type="button" variant="secondary" onClick={() => setItems([...items, { description: '', quantity: '1', unit_price: '' }])}>Add line</Button><strong aria-live="polite">Total: {money(Math.round(total * 100) / 100)}</strong></div>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create invoice</Button></div>
      </form>
    </Modal>
  );
}
