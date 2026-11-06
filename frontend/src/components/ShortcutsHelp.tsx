import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { ALL_NAV } from '../lib/nav';
import { Modal } from './ui';

const Kbd = ({ children }: { children: React.ReactNode }) => <kbd className="rounded border border-line bg-surface2 px-1.5 py-0.5 font-mono text-xs">{children}</kbd>;

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const goto = ALL_NAV.filter((n) => n.key && can(...n.perms));
  return (
    <Modal open={open} onClose={onClose} title={t('shortcuts.title')} wide>
      <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 sm:col-span-2"><dt>{t('shortcuts.search')}</dt><dd className="flex gap-1"><Kbd>Ctrl</Kbd><Kbd>K</Kbd><span className="px-1 text-muted">/</span><Kbd>/</Kbd></dd></div>
        <div className="flex items-center justify-between gap-3"><dt>{t('shortcuts.help')}</dt><dd><Kbd>?</Kbd></dd></div>
        <div className="flex items-center justify-between gap-3"><dt>{t('shortcuts.close')}</dt><dd><Kbd>Esc</Kbd></dd></div>
      </dl>
      <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">{t('shortcuts.goTo')}</h3>
      <ul className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
        {goto.map((n) => (
          <li key={n.to} className="flex items-center justify-between gap-3"><span>{t(n.labelKey)}</span><span className="flex gap-1"><Kbd>g</Kbd><Kbd>{n.key}</Kbd></span></li>
        ))}
      </ul>
      <p className="mt-5 text-xs text-muted">{t('shortcuts.hint')}</p>
    </Modal>
  );
}
