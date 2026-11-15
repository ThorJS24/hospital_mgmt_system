import { useState, type FormEvent } from 'react';
import { LogOut } from 'lucide-react';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { passwordAcceptable } from '../lib/password';
import { Alert, Button, TextField, errMsg, fieldErrors } from '../components/ui';
import { PasswordStrength } from '../components/PasswordStrength';
import { Brand } from '../components/Layout';

/** Shown instead of the application until a required password change is done (new accounts, administrator-forced). */
export default function ChangePasswordRequired() {
  const { user, refresh, logout } = useAuth();
  const [f, setF] = useState({ current_password: '', new_password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fe, setFe] = useState<Record<string, string>>({});
  const ctx = { username: user?.username, fullName: user?.fullName, email: user?.email };
  const mismatch = f.confirm !== '' && f.confirm !== f.new_password;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({});
    try { await post('/api/profile/password', { current_password: f.current_password, new_password: f.new_password }); await refresh(); } catch (x) { setErr(errMsg(x)); setFe(fieldErrors(x)); }
    setBusy(false);
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="card-shadow w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface p-7" aria-labelledby="cp-title">
        <Brand light={false} />
        <div>
          <h1 id="cp-title" className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
          <p className="mt-1 text-sm text-muted">Hello {user?.fullName}. Your account is using a temporary password, so you need to set your own before continuing.</p>
        </div>
        {err && <Alert>{err}</Alert>}
        <TextField label="Temporary (current) password" type="password" required autoComplete="current-password" autoFocus value={f.current_password} onChange={(e) => setF({ ...f, current_password: e.target.value })} />
        <TextField label="New password" type="password" required autoComplete="new-password" value={f.new_password} onChange={(e) => setF({ ...f, new_password: e.target.value })} error={fe.new_password} />
        <PasswordStrength value={f.new_password} context={ctx} />
        <TextField label="Repeat the new password" type="password" required autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} error={mismatch ? 'The two passwords do not match' : undefined} />
        <Button type="submit" loading={busy} className="w-full py-2.5" disabled={!f.current_password || !passwordAcceptable(f.new_password, ctx) || f.confirm !== f.new_password}>Save and continue</Button>
        <button type="button" onClick={() => void logout()} className="mx-auto flex items-center gap-1.5 text-sm text-muted hover:text-ink hover:underline"><LogOut className="h-4 w-4" aria-hidden />Sign out</button>
      </form>
    </div>
  );
}
