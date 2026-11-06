import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Search } from 'lucide-react';
import { get, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { ALL_NAV } from '../lib/nav';
import { cx } from './ui';

interface Item { key: string; group: string; title: string; subtitle: string; to: string }
interface RemoteGroup { type: string; label: string; items: { id: number | string; title: string; subtitle: string; to: string }[] }

/** Ctrl/Cmd+K palette: jump to pages, or search patients, invoices, staff and medicines the user may open. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<RemoteGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); setQ(''); setRemote([]); setActive(0); setTimeout(() => input.current?.focus(), 0); }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) { setRemote([]); setBusy(false); return; }
    setBusy(true);
    let live = true;
    const timer = setTimeout(() => {
      get<{ groups: RemoteGroup[] }>(`/api/search${qs({ q: term })}`).then((r) => { if (live) { setRemote(r.groups); setBusy(false); } }).catch(() => { if (live) { setRemote([]); setBusy(false); } });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [q, open]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const pages: Item[] = ALL_NAV.filter((n) => can(...n.perms)).map((n) => ({ key: `page:${n.to}`, group: 'Pages', title: t(n.labelKey), subtitle: n.to, to: n.to }))
      .filter((p) => !term || p.title.toLowerCase().includes(term));
    const found: Item[] = remote.flatMap((g) => g.items.map((i) => ({ key: `${g.type}:${i.id}`, group: g.label, title: i.title, subtitle: i.subtitle, to: i.to })));
    return [...found, ...pages];
  }, [q, remote, can, t]);

  useEffect(() => { setActive(0); }, [items.length, q]);

  const go = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.to.startsWith('/') && !item.to.startsWith('//')) navigate(item.to);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[active]); }
  };

  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, listId]);

  let lastGroup = '';
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label={t('topbar.search')}
      className="m-0 mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl rounded-xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50">
      {open && (
        <div onKeyDown={onKey}>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="h-4 w-4 text-muted" aria-hidden />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={items.length ? `${listId}-${active}` : undefined}
              aria-label={t('topbar.search')} placeholder={t('topbar.search')} autoComplete="off" spellCheck={false} className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted" />
            <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">Esc</kbd>
          </div>
          <ul id={listId} role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {busy && <li className="px-3 py-2 text-xs text-muted" role="status">{t('common.loading')}...</li>}
            {!busy && !items.length && <li className="px-3 py-6 text-center text-sm text-muted">{t('common.noResults')}</li>}
            {items.map((it, i) => {
              const header = it.group !== lastGroup;
              lastGroup = it.group;
              return (
                <li key={it.key} role="presentation">
                  {header && <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{it.group}</p>}
                  <div id={`${listId}-${i}`} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={() => go(it)}
                    className={cx('flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm', i === active ? 'bg-primary/10 text-ink' : 'hover:bg-surface2')}>
                    <span className="min-w-0"><span className="block truncate font-medium">{it.title}</span><span className="block truncate text-xs text-muted">{it.subtitle}</span></span>
                    {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </dialog>
  );
}
