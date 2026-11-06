import { Check, X } from 'lucide-react';
import { passwordChecks, passwordStrength } from '../lib/password';
import { cx } from './ui';

const LABEL = { empty: '', weak: 'Weak', fair: 'Fair', strong: 'Strong' } as const;
const BAR = { empty: 'bg-line', weak: 'bg-danger', fair: 'bg-warn', strong: 'bg-ok' } as const;

/** Live password hints. Purely advisory: the server enforces the same rules. */
export function PasswordStrength({ value, username }: { value: string; username?: string }) {
  const s = passwordStrength(value, username);
  const checks = passwordChecks(value, username);
  const filled = s.level === 'empty' ? 0 : s.level === 'weak' ? 1 : s.level === 'fair' ? 2 : 4;
  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden>{[0, 1, 2, 3].map((i) => <span key={i} className={cx('h-1.5 flex-1 rounded-full', i < filled ? BAR[s.level] : 'bg-line')} />)}</div>
        <span className="w-12 text-xs font-medium text-muted">{LABEL[s.level]}</span>
      </div>
      <ul className="grid gap-0.5 text-xs sm:grid-cols-2" aria-label="Password requirements">
        {checks.map((c) => (
          <li key={c.id} className={cx('flex items-center gap-1.5', value ? (c.ok ? 'text-ok' : 'text-muted') : 'text-muted')}>
            {c.ok && value ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
            <span>{c.label}<span className="sr-only-live">{c.ok && value ? ': met' : ': not met'}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
