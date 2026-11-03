import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { get, post, money, fmtDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, DataTable, Modal, PageHeader, SelectField, Spinner, StatusBadge, TextField, Toolbar, errMsg, useAsync, useList, useToast, type Column } from '../components/ui';

interface Row { id: number; invoice_no: string; status: string; issued_on: string; due_on: string; patient: string; mrn: string; total: number; paid: number; balance: number }

export default function Billing() {
  const { can } = useAuth(); const toast = useToast();
  const list = useList<Row>('/api/invoices');
  const [detail, setDetail] = useState<number | null>(null);
  const [create, setCreate] = useState(false);
  const cols: Column<Row>[] = [
    { key: 'invoice_no', label: 'Invoice' },
    { key: 'patient', label: 'Patient', render: (r) => <>{r.patient} <span className="text-muted">({r.mrn})</span></> },
    { key: 'issued_on', label: 'Issued', render: (r) => fmtDate(r.issued_on) },
    { key: 'due_on', label: 'Due', render: (r) => fmtDate(r.due_on) },
    { key: 'total', label: 'Total', className: 'text-right', render: (r) => money(r.total) },
    { key: 'balance', label: 'Balance', className: 'text-right', render: (r) => money(r.balance) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];
  return (
    <div>
      <PageHeader title="Billing" subtitle="Synthetic invoices - no real payment processing" actions={can('billing.write') ? <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New invoice</Button> : undefined} />
      <div className="card-shadow rounded-xl border border-line bg-surface p-4">
        <Toolbar list={list} placeholder="Invoice no., patient or MRN">
          <SelectField label="Status" value={list.state.filters.status ?? ''} onChange={(e) => list.setFilter('status', e.target.value)}><option value="">All</option>{['Draft', 'Issued', 'Partially paid', 'Paid', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}</SelectField>
          <TextField label="Issued from" type="date" value={list.state.filters.from ?? ''} onChange={(e) => list.setFilter('from', e.target.value)} />
          <TextField label="Issued to" type="date" value={list.state.filters.to ?? ''} onChange={(e) => list.setFilter('to', e.target.value)} />
        </Toolbar>
        <DataTable list={list} columns={cols} caption="Invoices" onRowClick={(r) => setDetail(r.id)} />
      </div>
      <Detail id={detail} onClose={() => { setDetail(null); list.reload(); }} />
      <CreateDialog open={create} onClose={() => setCreate(false)} onDone={() => { setCreate(false); list.reload(); toast('Invoice created'); }} />
    </div>
  );
}

function Detail({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { can } = useAuth(); const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => (id ? get(`/api/invoices/${id}`) : Promise.resolve(null)), [id]);
  const [amount, setAmount] = useState(''); const [err, setErr] = useState('');
  const pay = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await post(`/api/invoices/${id}/payments`, { amount: Number(amount) }); setAmount(''); toast('Payment recorded'); reload(); } catch (x) { setErr(errMsg(x)); }
  };
  const cancel = async () => { try { await post(`/api/invoices/${id}/cancel`); toast('Invoice cancelled'); reload(); } catch (x) { setErr(errMsg(x)); } };
  return (
    <Modal open={id !== null} onClose={onClose} title={data?.invoice_no ?? 'Invoice'} wide>
      {loading && !data ? <Spinner /> : error ? <Alert>{error}</Alert> : data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><p>{data.patient} ({data.mrn}) · issued {fmtDate(data.issued_on)} · due {fmtDate(data.due_on)}</p><StatusBadge status={data.status} /></div>
          <table className="w-full text-left text-sm"><caption className="sr-only-live">Line items</caption><thead className="text-xs uppercase text-muted"><tr><th className="py-1">Description</th><th className="text-right">Qty</th><th className="text-right">Unit price</th><th className="text-right">Line total</th></tr></thead>
            <tbody>{data.items.map((i: any) => <tr key={i.id} className="border-t border-line"><td className="py-1.5">{i.description}</td><td className="text-right">{i.quantity}</td><td className="text-right">{money(i.unit_price)}</td><td className="text-right">{money(i.line_total)}</td></tr>)}</tbody>
            <tfoot><tr className="border-t border-line font-semibold"><td colSpan={3} className="py-1.5 text-right">Total</td><td className="text-right">{money(data.total)}</td></tr><tr><td colSpan={3} className="text-right">Paid</td><td className="text-right">{money(data.paid)}</td></tr><tr className="font-semibold"><td colSpan={3} className="text-right">Outstanding balance</td><td className="text-right">{money(data.balance)}</td></tr></tfoot></table>
          {data.payments.length > 0 && <div><h3 className="mb-1 font-semibold">Payment history</h3><ul className="divide-y divide-line">{data.payments.map((p: any) => <li key={p.id} className="flex justify-between py-1"><span>{fmtDate(p.paid_at)} · {p.method}</span><span>{money(p.amount)}</span></li>)}</ul></div>}
          {err && <Alert>{err}</Alert>}
          {can('billing.write') && data.status !== 'Paid' && data.status !== 'Cancelled' && (
            <form onSubmit={pay} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <TextField label="Record payment (USD)" type="number" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button type="submit">Record payment</Button>
              {data.paid === 0 && <Button type="button" variant="danger" onClick={() => void cancel()}>Cancel invoice</Button>}
            </form>
          )}
        </div>
      )}
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
