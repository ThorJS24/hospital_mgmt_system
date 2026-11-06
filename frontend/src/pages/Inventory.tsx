import { useState } from 'react';
import { AlertTriangle, Boxes, CalendarX2, PackageMinus, Plus } from 'lucide-react';
import { get, patch, post, fmtDate, fmtDateTime, money } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Alert, Button, Card, DataTable, EmptyState, Modal, PageHeader, SelectField, Spinner, StatCard, StatusBadge, Tabs, TextField, Toolbar, cx, errMsg, useAsync, useList, useToast, type Column } from '../components/ui';

interface Item {
  id: number; code: string; name: string; form: string; strength: string; stock: number; reorder_level: number; unit_cost: number; expiry_date: string | null; days_to_expiry: number | null;
  supplier: string | null; supplier_id: number | null; low: boolean; expired: boolean; expiring: boolean; drug_class: string; max_daily_units: number | null;
}
interface Supplier { id: number; name: string; contact_email: string; phone: string; active: boolean; medications: number }

export default function Inventory() {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const [tab, setTab] = useState('all');
  const list = useList<Item>('/api/inventory');
  const alerts = useAsync(() => get('/api/inventory/alerts'), [list.rows]);
  const suppliers = useAsync(() => get<{ data: Supplier[] }>('/api/suppliers'), []);
  const [receive, setReceive] = useState<Item | null>(null);
  const [adjust, setAdjust] = useState<Item | null>(null);
  const [ledger, setLedger] = useState<Item | null>(null);
  const [newSupplier, setNewSupplier] = useState(false);
  const manage = can('inventory.manage');
  const refresh = () => { list.reload(); alerts.reload(); suppliers.reload(); };
  const setFilter = (id: string) => { setTab(id); if (id !== 'suppliers') list.setFilter('filter', id === 'all' ? '' : id); };

  const cols: Column<Item>[] = [
    { key: 'name', label: 'Medication', render: (m) => <span><strong>{m.name}</strong> {m.strength}<span className="block text-xs text-muted">{m.code} - {m.form}{m.drug_class && ` - ${m.drug_class}`}</span></span> },
    { key: 'stock', label: 'On hand', render: (m) => <span className={cx('tabular-nums', m.low && 'font-semibold text-warn')}>{m.stock}<span className="block text-xs font-normal text-muted">reorder at {m.reorder_level}</span></span> },
    { key: 'expiry_date', label: 'Expiry', render: (m) => m.expiry_date ? <span>{fmtDate(m.expiry_date)}{m.expired ? <span className="block"><StatusBadge status="Expired" tone="danger" /></span> : m.expiring ? <span className="block"><StatusBadge status={`${m.days_to_expiry} days left`} tone="warn" /></span> : null}</span> : <span className="text-muted">-</span> },
    { key: 'supplier', label: 'Supplier', render: (m) => m.supplier ?? <span className="text-muted">-</span> },
    { key: 'unit_cost', label: 'Unit cost', render: (m) => money(m.unit_cost) },
    { key: 'flags', label: 'Alerts', render: (m) => <span className="flex flex-wrap gap-1">{m.low && <StatusBadge status="Low stock" tone="warn" />}{m.expired && <StatusBadge status="Expired" tone="danger" />}{!m.low && !m.expired && !m.expiring && <StatusBadge status="OK" tone="ok" />}</span> },
  ];
  const a = alerts.data?.counts;

  return (
    <div className="space-y-4">
      <PageHeader title={t('page.inventory')} subtitle="Stock levels, reorder points, expiry dates and suppliers" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Low stock" value={a?.low ?? '-'} icon={PackageMinus} tone={a?.low ? 'warn' : 'ok'} sub="At or below the reorder level" />
        <StatCard label="Expiring in 30 days" value={a?.expiring ?? '-'} icon={AlertTriangle} tone={a?.expiring ? 'warn' : 'ok'} />
        <StatCard label="Expired" value={a?.expired ?? '-'} icon={CalendarX2} tone={a?.expired ? 'danger' : 'ok'} sub="Quarantine and write off" />
        <StatCard label="Stock value" value={alerts.data ? money(alerts.data.stockValue) : '-'} icon={Boxes} tone="info" />
      </div>
      <Card>
        <Tabs tabs={[{ id: 'all', label: 'All medications' }, { id: 'low', label: 'Low stock' }, { id: 'expiring', label: 'Expiring soon' }, { id: 'expired', label: 'Expired' }, { id: 'suppliers', label: 'Suppliers' }]} value={tab} onChange={setFilter} />
        <div className="mt-3">
          {tab === 'suppliers' ? (
            <>
              {manage && <div className="mb-3 flex justify-end"><Button onClick={() => setNewSupplier(true)}><Plus className="h-4 w-4" />Add supplier</Button></div>}
              {suppliers.error ? <Alert>{suppliers.error}</Alert> : suppliers.loading && !suppliers.data ? <Spinner /> : (
                <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only-live">Suppliers</caption>
                  <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-2">Supplier</th><th>Contact</th><th>Phone</th><th>Medications</th><th>Status</th>{manage && <th><span className="sr-only-live">Actions</span></th>}</tr></thead>
                  <tbody>{(suppliers.data?.data ?? []).map((s) => (
                    <tr key={s.id} className="border-t border-line"><td className="px-2 py-2 font-medium">{s.name}</td><td>{s.contact_email || '-'}</td><td>{s.phone || '-'}</td><td>{s.medications}</td><td><StatusBadge status={s.active ? 'Active' : 'Inactive'} /></td>
                      {manage && <td className="text-right"><Button variant="secondary" onClick={() => void patch(`/api/suppliers/${s.id}`, { active: !s.active }).then(() => { toast(s.active ? 'Supplier deactivated' : 'Supplier reactivated'); refresh(); }).catch((x) => toast(errMsg(x), 'danger'))}>{s.active ? 'Deactivate' : 'Reactivate'}</Button></td>}</tr>
                  ))}</tbody></table></div>
              )}
            </>
          ) : (
            <>
              <Toolbar list={list} placeholder="Name or code" />
              <DataTable list={list} columns={cols} caption="Inventory" empty={tab === 'all' ? 'No medications' : 'Nothing needs attention here'} actions={(m) => (
                <div className="flex flex-wrap justify-end gap-1.5">
                  {manage && <Button variant="secondary" onClick={() => setReceive(m)}>Receive</Button>}
                  {manage && <Button variant="ghost" onClick={() => setAdjust(m)}>Adjust</Button>}
                  <Button variant="ghost" onClick={() => setLedger(m)}>Ledger</Button>
                </div>
              )} />
              {!list.rows.length && !list.loading && tab !== 'all' && <EmptyState title="All clear" hint="No medications match this alert." />}
            </>
          )}
        </div>
      </Card>
      <ReceiveDialog item={receive} suppliers={(suppliers.data?.data ?? []).filter((s) => s.active)} onClose={() => setReceive(null)} onDone={() => { setReceive(null); toast('Stock received'); refresh(); }} />
      <AdjustDialog item={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); toast('Stock adjusted'); refresh(); }} />
      <LedgerDialog item={ledger} onClose={() => setLedger(null)} />
      <SupplierDialog open={newSupplier} onClose={() => setNewSupplier(false)} onDone={() => { setNewSupplier(false); toast('Supplier added'); refresh(); }} />
    </div>
  );
}

function ReceiveDialog({ item, suppliers, onClose, onDone }: { item: Item | null; suppliers: Supplier[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ quantity: '', expiry_date: '', supplier_id: '', note: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!item) return;
    setBusy(true); setErr('');
    try { await post(`/api/inventory/${item.id}/receive`, { quantity: Number(f.quantity), note: f.note, ...(f.expiry_date && { expiry_date: f.expiry_date }), ...(f.supplier_id && { supplier_id: Number(f.supplier_id) }) }); setF({ quantity: '', expiry_date: '', supplier_id: '', note: '' }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!item} onClose={onClose} title={item ? `Receive stock: ${item.name} ${item.strength}` : ''}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <TextField label="Quantity received" type="number" min={1} max={100000} required value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        <TextField label="New batch expiry date" type="date" value={f.expiry_date} onChange={(e) => setF({ ...f, expiry_date: e.target.value })} hint="Leave empty to keep the current expiry date" />
        <SelectField label="Supplier" value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}><option value="">Keep current ({item?.supplier ?? 'none'})</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SelectField>
        <TextField label="Reference" maxLength={200} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} hint="Purchase order or delivery note number" />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={Number(f.quantity) < 1}>Receive</Button></div>
      </form>
    </Modal>
  );
}

function AdjustDialog({ item, onClose, onDone }: { item: Item | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ delta: '', reason: 'Adjust', note: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!item) return;
    setBusy(true); setErr('');
    try { await post(`/api/inventory/${item.id}/adjust`, { delta: Number(f.delta), reason: f.reason, note: f.note.trim() }); setF({ delta: '', reason: 'Adjust', note: '' }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={!!item} onClose={onClose} title={item ? `Adjust stock: ${item.name} ${item.strength}` : ''}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <p className="text-sm text-muted">Currently {item?.stock} on hand. Use a negative number to remove stock.</p>
        <SelectField label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}><option value="Adjust">Stock count correction</option><option value="Expired">Write off expired or damaged stock</option></SelectField>
        <TextField label="Change in quantity" type="number" required value={f.delta} onChange={(e) => setF({ ...f, delta: e.target.value })} />
        <TextField label="Explanation" required maxLength={200} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} hint="Recorded in the ledger with your name" />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={!Number(f.delta) || f.note.trim().length < 3}>Apply</Button></div>
      </form>
    </Modal>
  );
}

function LedgerDialog({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const q = useAsync(() => (item ? get<{ data: { id: number; delta: number; reason: string; note: string; created_at: string; user: string | null }[] }>(`/api/inventory/${item.id}/movements`) : Promise.resolve({ data: [] })), [item?.id]);
  return (
    <Modal open={!!item} onClose={onClose} title={item ? `Stock ledger: ${item.name} ${item.strength}` : ''} wide>
      {q.loading ? <Spinner /> : q.error ? <Alert>{q.error}</Alert> : !(q.data?.data ?? []).length ? <EmptyState title="No movements yet" /> : (
        <table className="w-full text-left text-sm"><caption className="sr-only-live">Stock movements</caption>
          <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="py-1">When</th><th>Type</th><th className="text-right">Change</th><th>Note</th><th>By</th></tr></thead>
          <tbody>{q.data!.data.map((m) => <tr key={m.id} className="border-t border-line"><td className="py-1.5 whitespace-nowrap">{fmtDateTime(m.created_at)}</td><td>{m.reason}</td><td className={cx('text-right tabular-nums', m.delta < 0 ? 'text-danger' : 'text-ok')}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td><td>{m.note || '-'}</td><td>{m.user ?? 'System'}</td></tr>)}</tbody></table>
      )}
    </Modal>
  );
}

function SupplierDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', contact_email: '', phone: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await post('/api/suppliers', f); setF({ name: '', contact_email: '', phone: '' }); onDone(); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Add supplier">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <TextField label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextField label="Contact email" type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} />
        <TextField label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={f.name.trim().length < 2}>Add</Button></div>
      </form>
    </Modal>
  );
}
