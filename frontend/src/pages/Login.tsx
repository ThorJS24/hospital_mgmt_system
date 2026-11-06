import { useState, type FormEvent } from 'react';
import { CalendarCheck2, FlaskConical, ShieldCheck, BedDouble } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { post } from '../lib/api';
import { useT } from '../lib/i18n';
import { Alert, Button, TextField, errMsg, fieldErrors } from '../components/ui';
import { PasswordStrength } from '../components/PasswordStrength';
import { Brand } from '../components/Layout';

const FEATURES = [
  [CalendarCheck2, 'Scheduling', 'Appointments, rosters and department calendars'],
  [BedDouble, 'Inpatient care', 'Wards, beds, admissions and discharge'],
  [FlaskConical, 'Diagnostics & pharmacy', 'Lab requests, results and prescriptions'],
  [ShieldCheck, 'Role-based access', 'Every action checked against the staff role'],
] as const;

type Mode = 'login' | 'twofactor' | 'request' | 'confirm';

export default function Login() {
  const { login, verifyTwoFactor, lab } = useAuth();
  const { t } = useT();
  const [mode, setMode] = useState<Mode>('login');
  const [f, setF] = useState({ username: '', password: '', token: '', newPassword: '', code: '' });
  const [challenge, setChallenge] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fe, setFe] = useState<Record<string, string>>({});
  const [ok, setOk] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const afterSignIn = () => {
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && lab.mode === 'vulnerable') window.location.assign(`/api/lab/auth/redirect?next=${encodeURIComponent(next)}`);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFe({}); setOk('');
    const username = f.username.trim();
    try {
      if (mode === 'login') {
        const r = await login(username, f.password);
        if (r.twoFactorRequired && r.challenge) { setChallenge(r.challenge); setF({ ...f, password: '', code: '' }); setMode('twofactor'); }
        else afterSignIn();
      } else if (mode === 'twofactor') {
        await verifyTwoFactor(challenge, f.code.trim());
        afterSignIn();
      } else if (mode === 'request') { const r = await post('/api/auth/password-reset/request', { username }); setOk(r.message); setMode('confirm'); }
      else { await post('/api/auth/password-reset/confirm', { username, token: f.token.trim(), new_password: f.newPassword }); setOk('Password updated. You can sign in now.'); setMode('login'); }
    } catch (x) {
      setErr(errMsg(x)); setFe(fieldErrors(x));
      if (mode === 'twofactor' && /expired|too many/i.test(errMsg(x))) { setMode('login'); setChallenge(''); }
    }
    setBusy(false);
  };

  const title = mode === 'login' ? t('login.welcome') : mode === 'twofactor' ? t('login.twoTitle') : mode === 'request' ? 'Reset password' : 'Enter reset code';
  const subtitle = mode === 'login' ? t('login.sub') : mode === 'twofactor' ? t('login.twoSub') : mode === 'request' ? 'Enter your username to receive a one-time code.' : 'Enter the code and choose a new password.';
  const submitLabel = mode === 'login' ? t('login.signIn') : mode === 'twofactor' ? t('login.verify') : mode === 'request' ? 'Send reset code' : 'Set new password';

  return (
    <div className="flex min-h-screen flex-col">
      <div className="grid flex-1 lg:grid-cols-[1.1fr_1fr]">
        <aside className="hero hidden flex-col justify-between p-12 text-white lg:flex">
          <Brand />
          <div className="max-w-md">
            <h2 className="text-4xl font-semibold leading-tight tracking-tight">Coordinated care, from front desk to bedside.</h2>
            <p className="mt-3 text-white/70">One workspace for patients, clinicians and hospital operations.</p>
            <ul className="mt-8 space-y-4">
              {FEATURES.map(([Icon, ft, d]) => (
                <li key={ft} className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10"><Icon className="h-4 w-4" aria-hidden /></span><span><span className="block font-medium">{ft}</span><span className="text-sm text-white/65">{d}</span></span></li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-white/50">Fictional hospital · synthetic records only</p>
        </aside>
        <main className="flex items-center justify-center bg-bg p-6">
          <form onSubmit={submit} className="card-shadow w-full max-w-sm space-y-4 rounded-2xl border border-line bg-surface p-7" aria-labelledby="login-title">
            <div className="lg:hidden"><Brand light={false} /></div>
            <div><h1 id="login-title" className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted">{subtitle}</p></div>
            {err && <Alert>{err}</Alert>}
            {ok && <Alert tone="ok">{ok}</Alert>}
            {mode !== 'twofactor' && <TextField label={t('login.username')} required autoComplete="username" autoFocus value={f.username} onChange={set('username')} error={fe.username} />}
            {mode === 'login' && <TextField label={t('login.password')} type="password" required autoComplete="current-password" value={f.password} onChange={set('password')} error={fe.password} />}
            {mode === 'twofactor' && <TextField label={t('login.code')} required autoFocus autoComplete="one-time-code" inputMode="text" value={f.code} onChange={set('code')} hint="6 digits, or a recovery code such as 1a2b-3c4d" />}
            {mode === 'confirm' && <>
              <TextField label="Reset code" required value={f.token} onChange={set('token')} hint="Delivered to the local synthetic outbox (Administration → Local outbox)." error={fe.token} />
              <TextField label="New password" type="password" required autoComplete="new-password" value={f.newPassword} onChange={set('newPassword')} error={fe.new_password} />
              <PasswordStrength value={f.newPassword} username={f.username.trim()} />
            </>}
            <Button type="submit" loading={busy} className="w-full py-2.5">{submitLabel}</Button>
            <div className="text-center text-sm">
              {mode === 'login'
                ? <button type="button" className="text-primary hover:underline" onClick={() => { setMode('request'); setErr(''); setOk(''); }}>{t('login.forgot')}</button>
                : <button type="button" className="text-primary hover:underline" onClick={() => { setMode('login'); setErr(''); setOk(''); setChallenge(''); }}>{t('login.backToSignIn')}</button>}
            </div>
            <p className="border-t border-line pt-3 text-center text-xs text-muted">Development accounts are listed in the project README.</p>
          </form>
        </main>
      </div>
    </div>
  );
}
