import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { get, patch, post, put, fmtDateTime } from '../lib/api';
import { AuditExport, useLabMode } from '../components/vulnerable/LabTools';
import { Alert, Button, Card, DataTable, Modal, PageHeader, SelectField, StatusBadge, Tabs, TextField, Toolbar, errMsg, fieldErrors, useAsync, useList, useToast, type Column } from '../components/ui';

const ROLES = [['administrator', 'Administrator'], ['doctor', 'Doctor'], ['nurse', 'Nurse'], ['receptionist', 'Receptionist'], ['lab_technician', 'Laboratory Technician'], ['pharmacist', 'Pharmacist'], ['billing_officer', 'Billing Officer']];

export default function Admin() {
  const [tab, setTab] = useState('users');
  return (
    <div>
      <PageHeader title="Administration" subtitle="Hospital administration. Assessment administration is separate and not available here." />
      <Tabs tabs={[{ id: 'users', label: 'Users & roles' }, { id: 'config', label: 'System configuration' }, { id: 'audit', label: 'Activity log' }, { id: 'outbox', label: 'Local outbox' }]} value={tab} onChange={setTab} />
      <div className="mt-4">{tab === 'users' ? <Users /> : tab === 'config' ? <Config /> : tab === 'audit' ? <Audit /> : <Outbox />}</div>
    </div>
  );
}

interface U { id: number; username: string; full_name: string; email: string; active: boolean; role: string; role_name: string; created_at: string }
function Users() {
  const toast = useToast();
  const list = useList<U>('/api/admin/users', '');
  const [open, setOpen] = useState(false);
  const change = async (u: U, body: object) => { try { await patch(`/api/admin/users/${u.id}`, body); toast('User updated'); list.reload(); } catch (x) { toast(errMsg(x), 'danger'); } };
  const cols: Column<U>[] = [
    { key: 'username', label: 'Username' }, { key: 'full_name', label: 'Name' }, { key: 'email', label: 'Email' },
    { key: 'role', label: 'Role', render: (u) => u.role === 'security_assessor' ? <span>{u.role_name} <span className="text-xs text-muted">(managed separately)</span></span> : (
      <select aria-label={`Role for ${u.username}`} className="rounded-md border border-line bg-surface px-2 py-1 text-xs" value={u.role} onChange={(e) => void change(u, { role: e.target.value })}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>) },
    { key: 'active', label: 'Status', render: (u) => <StatusBadge status={u.active ? 'Active' : 'Inactive'} /> },
  ];
  return (
    <Card title="Application users" actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Add user</Button>}>
      <Toolbar list={list} placeholder="Username or name" />
      <DataTable list={list} columns={cols} caption="Users" actions={(u) => u.role === 'security_assessor' ? null : <Button variant="ghost" onClick={() => void change(u, { active: !u.active })}>{u.active ? 'Deactivate' : 'Activate'}</Button>} />
      <AddUser open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); list.reload(); toast('User created'); }} />
    </Card>
  );
}

function AddUser({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ username: '', full_name: '', email: '', role: 'receptionist', password: '' });
  const [err, setErr] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    try { await post('/api/admin/users', f); setF({ username: '', full_name: '', email: '', role: 'receptionist', password: '' }); onDone(); } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="Add user">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <TextField label="Username" required value={f.username} onChange={set('username')} error={fe.username} />
        <TextField label="Full name" required value={f.full_name} onChange={set('full_name')} error={fe.full_name} />
        <TextField label="Email" type="email" required value={f.email} onChange={set('email')} error={fe.email} />
        <SelectField label="Role" required value={f.role} onChange={set('role')}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField>
        <TextField label="Initial password" type="password" required value={f.password} onChange={set('password')} error={fe.password} hint="At least 10 characters" />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create user</Button></div>
      </form>
    </Modal>
  );
}

function Config() {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => get('/api/admin/config'), []);
  const [edit, setEdit] = useState<Record<string, string>>({});
  if (error) return <Alert>{error}</Alert>;
  return (
    <Card title="System configuration">
      <ul className="divide-y divide-line">{(data?.data ?? []).map((c: any) => (
        <li key={c.key} className="flex flex-wrap items-end gap-3 py-2">
          <div className="min-w-48 flex-1"><TextField label={`${c.key}`} hint={c.description} value={edit[c.key] ?? c.value} onChange={(e) => setEdit({ ...edit, [c.key]: e.target.value })} /></div>
          <Button variant="secondary" disabled={edit[c.key] === undefined || edit[c.key] === c.value} onClick={async () => { try { await put(`/api/admin/config/${c.key}`, { value: edit[c.key] }); toast('Configuration saved'); setEdit({}); reload(); } catch (x) { toast(errMsg(x), 'danger'); } }}>Save</Button>
        </li>))}</ul>
    </Card>
  );
}

function Audit() {
  const lab = useLabMode();
  const list = useList<any>('/api/admin/audit', '', 20);
  const cols: Column<any>[] = [
    { key: 'at', label: 'Time', render: (r) => fmtDateTime(r.at), className: 'whitespace-nowrap' }, { key: 'username', label: 'User', render: (r) => r.username ?? 'system' },
    { key: 'action', label: 'Action' }, { key: 'entity', label: 'Entity', render: (r) => `${r.entity} ${r.entity_id}` }, { key: 'detail', label: 'Detail' },
    { key: 'request_id', label: 'Request ID', render: (r) => <code className="text-xs">{String(r.request_id).slice(0, 8)}</code> },
  ];
  return <div className="space-y-4"><Card title="Activity log"><Toolbar list={list} placeholder="Action, user or entity" /><DataTable list={list} columns={cols} caption="Audit events" /></Card>{lab && <AuditExport />}</div>;
}

function Outbox() {
  const { data, error, reload } = useAsync(() => get('/api/admin/outbox'), []);
  if (error) return <Alert>{error}</Alert>;
  return (
    <Card title="Local synthetic outbox" actions={<Button variant="secondary" onClick={reload}>Refresh</Button>}>
      <p className="mb-2 text-xs text-muted">{data?.note ?? 'Password-reset codes appear here because no email is sent in this lab.'}</p>
      {(data?.data ?? []).length === 0 ? <p className="text-muted">No reset codes issued in the last 24 hours.</p> : <table className="w-full text-left text-sm"><thead className="text-xs uppercase text-muted"><tr><th className="py-1">User</th><th>Code</th><th>Issued</th><th>State</th></tr></thead><tbody>{data.data.map((r: any) => <tr key={r.id} className="border-t border-line"><td className="py-1.5">{r.username}</td><td><code>{r.code}</code></td><td>{fmtDateTime(r.created_at)}</td><td><StatusBadge status={r.used ? 'Completed' : 'Pending'} /></td></tr>)}</tbody></table>}
    </Card>
  );
}
