import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Bell, Info, OctagonAlert } from 'lucide-react';
import { get, post, fmtDateTime } from '../lib/api';
import { useLiveTick } from '../lib/live';
import { useT } from '../lib/i18n';
import { cx } from './ui';

interface Notif { id: number; kind: string; severity: 'info' | 'warn' | 'critical'; title: string; body: string; link: string; created_at: string; read_at: string | null }
interface Payload { data: Notif[]; unread: number; critical: number }

const SEVERITY = {
  info: { icon: Info, cls: 'text-info' },
  warn: { icon: AlertTriangle, cls: 'text-warn' },
  critical: { icon: OctagonAlert, cls: 'text-danger' },
} as const;

export function NotificationBell() {
  const { t } = useT();
  const navigate = useNavigate();
  const tick = useLiveTick();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => { get<Payload>('/api/notifications?limit=20').then(setData).catch(() => { /* keep the previous list */ }); }, []);
  useEffect(() => { load(); }, [load, tick]);
  useEffect(() => { const i = setInterval(load, 60_000); return () => clearInterval(i); }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const markRead = async (n: Notif) => {
    if (!n.read_at) { try { await post(`/api/notifications/${n.id}/read`); } catch { /* ignore */ } load(); }
  };
  const openItem = async (n: Notif) => {
    await markRead(n);
    setOpen(false);
    // only in-app paths are ever followed
    if (n.link.startsWith('/') && !n.link.startsWith('//')) navigate(n.link);
  };
  const markAll = async () => { try { await post('/api/notifications/read-all'); } catch { /* ignore */ } load(); };

  const unread = data?.unread ?? 0;
  const critical = data?.critical ?? 0;
  return (
    <div ref={root} className="relative" data-tour="bell">
      <button ref={button} onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}
        aria-label={`${t('topbar.notifications')}${unread ? ` (${unread} unread${critical ? `, ${critical} critical` : ''})` : ''}`}
        className="relative rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink">
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span className={cx('absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white', critical ? 'bg-danger' : 'bg-primary')} aria-hidden>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>
      {open && (
        <section aria-label={t('topbar.notifications')} className="card-shadow absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-line bg-surface">
          <header className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold">{t('topbar.notifications')}</h2>
            <button className="text-xs text-primary hover:underline disabled:text-muted disabled:no-underline" onClick={markAll} disabled={!unread}>{t('topbar.markAll')}</button>
          </header>
          <ul className="max-h-96 overflow-y-auto">
            {!data?.data.length ? <li className="px-4 py-8 text-center text-sm text-muted">{t('topbar.none')}</li> : data.data.map((n) => {
              const S = SEVERITY[n.severity];
              return (
                <li key={n.id} className="border-b border-line last:border-0">
                  <button onClick={() => void openItem(n)} className={cx('flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-surface2', !n.read_at && 'bg-primary/5')}>
                    <S.icon className={cx('mt-0.5 h-4 w-4 shrink-0', S.cls)} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={cx('block text-sm', !n.read_at && 'font-semibold')}>{n.title}{n.severity === 'critical' && <span className="sr-only-live"> (critical)</span>}</span>
                      {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                      <span className="block text-[11px] text-muted">{fmtDateTime(n.created_at)}</span>
                    </span>
                    {!n.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
