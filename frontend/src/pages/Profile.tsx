import { useState, type FormEvent } from 'react';
import { patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ApiTokenCard, useLabMode } from '../components/vulnerable/LabTools';
import { Alert, Button, Card, KV, PageHeader, TextField, errMsg, fieldErrors, useToast } from '../components/ui';

export default function Profile() {
  const { user, refresh } = useAuth(); const toast = useToast();
  const lab = useLabMode();
  const [p, setP] = useState({ full_name: user?.fullName ?? '', email: user?.email ?? '' });
  const [pw, setPw] = useState({ current_password: '', new_password: '' });
  const [e1, setE1] = useState(''); const [e2, setE2] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [b1, setB1] = useState(false); const [b2, setB2] = useState(false);
  const save = async (e: FormEvent) => { e.preventDefault(); setB1(true); setE1(''); try { await patch('/api/profile', p); await refresh(); toast('Profile updated'); } catch (x) { setE1(errMsg(x)); } setB1(false); };
  const change = async (e: FormEvent) => { e.preventDefault(); setB2(true); setE2(''); setFe({}); try { await post('/api/profile/password', pw); setPw({ current_password: '', new_password: '' }); toast('Password changed; other sessions were signed out'); } catch (x) { setE2(errMsg(x)); setFe(fieldErrors(x)); } setB2(false); };
  return (
    <div className="space-y-4">
      <PageHeader title="My profile" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Account"><dl className="mb-4 grid grid-cols-2 gap-3"><KV label="Username">{user?.username}</KV><KV label="Role">{user?.roleName}</KV></dl>
          <form onSubmit={save} className="space-y-3" noValidate>{e1 && <Alert>{e1}</Alert>}
            <TextField label="Full name" required value={p.full_name} onChange={(e) => setP({ ...p, full_name: e.target.value })} />
            <TextField label="Email" type="email" required value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} />
            <Button type="submit" loading={b1}>Save profile</Button></form></Card>
        <Card title="Change password"><form onSubmit={change} className="space-y-3" noValidate>{e2 && <Alert>{e2}</Alert>}
          <TextField label="Current password" type="password" autoComplete="current-password" required value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
          <TextField label="New password" type="password" autoComplete="new-password" required value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} hint="At least 10 characters" error={fe.new_password} />
          <Button type="submit" loading={b2}>Change password</Button></form></Card>
      </div>
      {lab && <ApiTokenCard />}
    </div>
  );
}
