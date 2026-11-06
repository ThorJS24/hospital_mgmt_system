import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Copy, Download, KeyRound, Laptop, LogOut, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { del, get, patch, post, fmtDateTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { PasswordStrength } from '../components/PasswordStrength';
import { passwordAcceptable } from '../lib/password';
import { describeAgent } from '../lib/agent';
import { Alert, Button, Card, KV, Modal, PageHeader, Spinner, StatusBadge, TextField, errMsg, fieldErrors, useAsync, useToast } from '../components/ui';

export default function Profile() {
  const { user, refresh } = useAuth(); const toast = useToast();
  const { t } = useT();
  const [p, setP] = useState({ full_name: user?.fullName ?? '', email: user?.email ?? '' });
  const [pw, setPw] = useState({ current_password: '', new_password: '' });
  const [e1, setE1] = useState(''); const [e2, setE2] = useState(''); const [fe, setFe] = useState<Record<string, string>>({}); const [b1, setB1] = useState(false); const [b2, setB2] = useState(false);
  const save = async (e: FormEvent) => { e.preventDefault(); setB1(true); setE1(''); try { await patch('/api/profile', p); await refresh(); toast('Profile updated'); } catch (x) { setE1(errMsg(x)); } setB1(false); };
  const change = async (e: FormEvent) => {
    e.preventDefault(); setB2(true); setE2(''); setFe({});
    try { await post('/api/profile/password', pw); setPw({ current_password: '', new_password: '' }); toast('Password changed; other sessions were signed out'); } catch (x) { setE2(errMsg(x)); setFe(fieldErrors(x)); }
    setB2(false);
  };
  return (
    <div className="space-y-4">
      <PageHeader title={t('page.profile')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Account"><dl className="mb-4 grid grid-cols-2 gap-3"><KV label="Username">{user?.username}</KV><KV label="Role">{user?.roleName}</KV></dl>
          <form onSubmit={save} className="space-y-3" noValidate>{e1 && <Alert>{e1}</Alert>}
            <TextField label="Full name" required value={p.full_name} onChange={(e) => setP({ ...p, full_name: e.target.value })} />
            <TextField label="Email" type="email" required value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} />
            <Button type="submit" loading={b1}>Save profile</Button></form></Card>
        <Card title="Change password"><form onSubmit={change} className="space-y-3" noValidate>{e2 && <Alert>{e2}</Alert>}
          <TextField label="Current password" type="password" autoComplete="current-password" required value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
          <TextField label="New password" type="password" autoComplete="new-password" required value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} error={fe.new_password} />
          <PasswordStrength value={pw.new_password} username={user?.username} />
          <Button type="submit" loading={b2} disabled={!pw.current_password || !passwordAcceptable(pw.new_password, user?.username)}>Change password</Button></form></Card>
        <TwoFactor />
        <Sessions />
      </div>
    </div>
  );
}

function TwoFactor() {
  const { user, refresh } = useAuth(); const toast = useToast();
  const status = useAsync(() => get<{ enabled: boolean; recoveryCodesLeft: number }>('/api/auth/2fa/status'), [user?.totpEnabled]);
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'disable' | 'regenerate' | null>(null);

  useEffect(() => {
    if (!setup) { setQr(''); return; }
    let live = true;
    QRCode.toDataURL(setup.otpauth, { margin: 1, width: 192 }).then((u) => live && setQr(u)).catch(() => live && setQr(''));
    return () => { live = false; };
  }, [setup]);

  const start = async () => { setBusy(true); setErr(''); try { setSetup(await post('/api/auth/2fa/setup')); setCode(''); } catch (x) { setErr(errMsg(x)); } setBusy(false); };
  const enable = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await post('/api/auth/2fa/enable', { code: code.trim() }); setCodes(r.recoveryCodes); setSetup(null); await refresh(); toast('Two-step verification is on'); } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  const grouped = setup?.secret.match(/.{1,4}/g)?.join(' ') ?? '';
  const copyCodes = async () => { try { await navigator.clipboard.writeText((codes ?? []).join('\n')); toast('Recovery codes copied'); } catch { toast('Copy failed: select the codes manually', 'danger'); } };
  const downloadCodes = () => {
    const blob = new Blob([`MediCore recovery codes for ${user?.username}\n(each works once)\n\n${(codes ?? []).join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'medicore-recovery-codes.txt'; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <Card title="Two-step verification" actions={status.data?.enabled ? <StatusBadge status="On" tone="ok" /> : <StatusBadge status="Off" tone="warn" />}>
      {status.loading && !status.data ? <Spinner /> : (
        <div className="space-y-3 text-sm">
          {err && <Alert>{err}</Alert>}
          {!status.data?.enabled && !setup && !codes && (
            <>
              <p className="text-muted">Add a second step at sign-in using an authenticator app (such as Google Authenticator, Microsoft Authenticator or Aegis). A stolen password alone is then not enough to get in.</p>
              <Button loading={busy} onClick={start}><ShieldCheck className="h-4 w-4" />Set up two-step verification</Button>
            </>
          )}
          {setup && (
            <form onSubmit={enable} className="space-y-3">
              <ol className="list-decimal space-y-1 pl-5 text-muted"><li>Scan the QR code with your authenticator app, or enter the key by hand.</li><li>Type the 6-digit code the app shows to confirm.</li></ol>
              <div className="flex flex-wrap items-center gap-4">
                {qr ? <img src={qr} alt="QR code for the authenticator app" width={160} height={160} className="rounded-lg border border-line bg-white p-1" /> : <div className="h-40 w-40 animate-pulse rounded-lg bg-surface2" aria-hidden />}
                <div><p className="text-xs text-muted">Setup key</p><code className="block break-all rounded bg-surface2 px-2 py-1 font-mono text-sm tracking-wider" aria-label={`Setup key ${setup.secret.split('').join(' ')}`}>{grouped}</code></div>
              </div>
              <TextField label="6-digit code" required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <div className="flex gap-2"><Button type="submit" loading={busy} disabled={code.length !== 6}>Turn on</Button><Button type="button" variant="secondary" onClick={() => { setSetup(null); setErr(''); }}>Cancel</Button></div>
            </form>
          )}
          {codes && (
            <div className="space-y-2 rounded-lg border border-warn/50 bg-warn/10 p-3">
              <p className="font-medium">Save your recovery codes now</p>
              <p className="text-muted">Each code works once if you lose your phone. They will not be shown again.</p>
              <ul className="grid grid-cols-2 gap-1 font-mono text-sm" aria-label="Recovery codes">{codes.map((c) => <li key={c} className="rounded bg-surface px-2 py-1">{c}</li>)}</ul>
              <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={copyCodes}><Copy className="h-4 w-4" />Copy</Button><Button variant="secondary" onClick={downloadCodes}><Download className="h-4 w-4" />Download</Button><Button onClick={() => setCodes(null)}>I have saved them</Button></div>
            </div>
          )}
          {status.data?.enabled && !codes && (
            <>
              <p className="flex items-center gap-2 text-ok"><ShieldCheck className="h-4 w-4" aria-hidden />Sign-in asks for a code from your authenticator app.</p>
              <p className="text-muted">{status.data.recoveryCodesLeft} recovery code{status.data.recoveryCodesLeft === 1 ? '' : 's'} left{status.data.recoveryCodesLeft <= 2 && <span className="font-medium text-warn"> - generate new ones soon</span>}.</p>
              <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setConfirm('regenerate')}><KeyRound className="h-4 w-4" />New recovery codes</Button><Button variant="danger" onClick={() => setConfirm('disable')}><ShieldOff className="h-4 w-4" />Turn off</Button></div>
            </>
          )}
        </div>
      )}
      <ConfirmFactor mode={confirm} onClose={() => setConfirm(null)} onDisabled={async () => { setConfirm(null); toast('Two-step verification is off'); await refresh(); status.reload(); }} onCodes={(c) => { setConfirm(null); setCodes(c); status.reload(); }} />
    </Card>
  );
}

function ConfirmFactor({ mode, onClose, onDisabled, onCodes }: { mode: 'disable' | 'regenerate' | null; onClose: () => void; onDisabled: () => void; onCodes: (c: string[]) => void }) {
  const [f, setF] = useState({ password: '', code: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      if (mode === 'disable') { await post('/api/auth/2fa/disable', f); setF({ password: '', code: '' }); onDisabled(); }
      else { const r = await post('/api/auth/2fa/recovery-codes', f); setF({ password: '', code: '' }); onCodes(r.recoveryCodes); }
    } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Modal open={mode !== null} onClose={onClose} title={mode === 'disable' ? 'Turn off two-step verification' : 'Generate new recovery codes'}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {err && <Alert>{err}</Alert>}
        <p className="text-sm text-muted">{mode === 'disable' ? 'Confirm with your password and a current code (or a recovery code).' : 'This replaces all existing recovery codes. Confirm with your password and a current code.'}</p>
        <TextField label="Password" type="password" required autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <TextField label="Authenticator or recovery code" required autoComplete="one-time-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" variant={mode === 'disable' ? 'danger' : 'primary'} loading={busy} disabled={!f.password || f.code.trim().length < 6}>{mode === 'disable' ? 'Turn off' : 'Generate'}</Button></div>
      </form>
    </Modal>
  );
}

function Sessions() {
  const toast = useToast();
  const list = useAsync(() => get<{ data: { ref: string; created_at: string; last_seen: string; ip: string; user_agent: string; current: boolean }[] }>('/api/auth/sessions'), []);
  const [busy, setBusy] = useState('');
  const revoke = async (ref: string) => { setBusy(ref); try { await del(`/api/auth/sessions/${ref}`); toast('Session signed out'); list.reload(); } catch (x) { toast(errMsg(x), 'danger'); } setBusy(''); };
  const revokeOthers = async () => { setBusy('all'); try { const r = await post('/api/auth/sessions/revoke-others'); toast(`Signed out of ${r.revoked} other session${r.revoked === 1 ? '' : 's'}`); list.reload(); } catch (x) { toast(errMsg(x), 'danger'); } setBusy(''); };
  const rows = list.data?.data ?? [];
  return (
    <Card title="Where you are signed in" actions={<Button variant="secondary" loading={busy === 'all'} disabled={rows.length < 2} onClick={revokeOthers}><LogOut className="h-4 w-4" />Sign out other devices</Button>}>
      {list.error ? <Alert>{list.error}</Alert> : list.loading && !list.data ? <Spinner /> : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((s) => {
            const d = describeAgent(s.user_agent);
            return (
              <li key={s.ref} className="flex flex-wrap items-center gap-3 py-2">
                {d.mobile ? <Smartphone className="h-5 w-5 text-muted" aria-hidden /> : <Laptop className="h-5 w-5 text-muted" aria-hidden />}
                <span className="min-w-0 flex-1"><span className="font-medium">{d.label}</span> {s.current && <StatusBadge status="This device" tone="ok" />}<span className="block text-xs text-muted">{s.ip || 'unknown address'} - signed in {fmtDateTime(s.created_at)} - active {fmtDateTime(s.last_seen)}</span></span>
                {!s.current && <Button variant="ghost" loading={busy === s.ref} onClick={() => void revoke(s.ref)} aria-label={`Sign out ${d.label}`}>Sign out</Button>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">Changing your password signs out every other device automatically.</p>
    </Card>
  );
}
