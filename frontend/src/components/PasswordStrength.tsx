import { Check, X } from 'lucide-react';
import { passwordChecks, passwordStrength, type PolicyContext } from '../lib/password';
import { cx } from './ui';

const LABEL = { empty: '', weak: 'Weak', fair: 'Good', strong: 'Strong' } as const;
const BAR = { empty: 'bg-line', weak: 'bg-danger', fair: 'bg-warn', strong: 'bg-ok' } as const;
const FILLED = { empty: 0, weak: 1, fair: 3, strong: 4 } as const;

/** Live password hints from the same rules the server enforces. Length matters most: a few ordinary words make a strong passphrase. */
export function PasswordStrength({ value, context }: { value: string; context?: PolicyContext }) {
  const level = passwordStrength(value, context);
  const checks = passwordChecks(value, context);
  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden>{[0, 1, 2, 3].map((i) => <span key={i} className={cx('h-1.5 flex-1 rounded-full', i < FILLED[level] ? BAR[level] : 'bg-line')} />)}</div>
        <span className="w-12 text-xs font-medium text-muted">{LABEL[level]}</span>
      </div>
      <ul className="grid gap-0.5 text-xs" aria-label="Password requirements">
        {checks.map((c) => (
          <li key={c.id} className={cx('flex items-center gap-1.5', value && c.ok ? 'text-ok' : 'text-muted')}>
            {c.ok && value ? <Check className="h-3 w-3 shrink-0" aria-hidden /> : <X className="h-3 w-3 shrink-0" aria-hidden />}
            <span>{c.label}<span className="sr-only-live">{c.ok && value ? ': met' : ': not met'}</span></span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">There are no symbol or capital-letter rules: length and unpredictability protect you. You cannot reuse your last 5 passwords.</p>
    </div>
  );
}
