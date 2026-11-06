import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Activity, CircleHelp, Languages, LogOut, Menu, Moon, Search, Sun, HeartPulse, Play } from 'lucide-react';
import { useAuth, useTheme } from '../lib/auth';
import { useLive } from '../lib/live';
import { LANGS, isLang, useT } from '../lib/i18n';
import { ALL_NAV, NAV_GROUPS, firstAllowedRoute } from '../lib/nav';
import { Avatar, staffGender } from './Avatar';
import { NotificationBell } from './NotificationBell';
import { CommandPalette } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';
import { Tour, tourSeen } from './Tour';
import { cx } from './ui';

export const firstAllowed = firstAllowedRoute;

export const Brand = ({ light = true }: { light?: boolean }) => (
  <div className="flex items-center gap-2.5">
    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-cyan-300/80 text-white shadow"><HeartPulse className="h-5 w-5" aria-hidden /></span>
    <span className={cx('leading-tight', light ? 'text-white' : 'text-ink')}><span className="block text-base font-semibold tracking-tight">MediCore</span><span className="block text-[10px] uppercase tracking-[0.18em] opacity-70">Hospital Management</span></span>
  </div>
);

function Crumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-muted">
      <ol className="flex flex-wrap items-center gap-1">
        <li><Link to="/" className="hover:underline">MediCore</Link></li>
        {parts.map((p, i) => (
          <li key={i} className="flex items-center gap-1"><span aria-hidden>/</span>
            {i === parts.length - 1 ? <span aria-current="page" className="font-medium capitalize text-ink">{p}</span> : <Link className="capitalize hover:underline" to={'/' + parts.slice(0, i + 1).join('/')}>{p}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function LivePill() {
  const { connected } = useLive();
  const { t } = useT();
  const [now, setNow] = useState(new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  return (
    <div className="hidden items-center gap-3 text-xs text-muted xl:flex">
      <span className="tabular-nums" aria-label="Current time">{now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · {now.toLocaleTimeString()}</span>
      <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium', connected ? 'bg-ok/15 text-ok' : 'bg-surface2 text-muted')} role="status">
        <span className={cx('h-1.5 w-1.5 rounded-full', connected ? 'animate-pulse bg-ok' : 'bg-muted')} aria-hidden />{connected ? t('topbar.live') : t('topbar.offline')}
      </span>
    </div>
  );
}

function LanguageSwitch() {
  const { lang, setLang, t } = useT();
  return (
    <label className="relative flex items-center rounded-lg text-muted hover:bg-surface2 hover:text-ink">
      <Languages className="pointer-events-none absolute left-2 h-4 w-4" aria-hidden />
      <span className="sr-only-live">{t('topbar.language')}</span>
      <select value={lang} onChange={(e) => isLang(e.target.value) && setLang(e.target.value)} aria-label={t('topbar.language')}
        className="cursor-pointer appearance-none rounded-lg bg-transparent py-2 pl-8 pr-2 text-xs font-medium text-inherit">
        {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
    </label>
  );
}

export default function Layout() {
  const { user, can, logout, lab } = useAuth();
  const { t } = useT();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [tour, setTour] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);

  // first-run onboarding
  useEffect(() => {
    if (tourSeen()) return;
    const id = setTimeout(() => setTour(true), 900);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (menuRoot.current && !menuRoot.current.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  // keyboard shortcuts: Ctrl/Cmd+K and "/" search, "?" help, "g" then a letter to navigate
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); return; }
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || el?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
      if (e.key === '?') { e.preventDefault(); setHelp(true); return; }
      if (e.key === '/') { e.preventDefault(); setPalette(true); return; }
      if (gAt && Date.now() - gAt < 1500) {
        gAt = 0;
        const item = ALL_NAV.find((n) => n.key === e.key.toLowerCase() && can(...n.perms));
        if (item) { e.preventDefault(); navigate(item.to); }
        return;
      }
      if (e.key.toLowerCase() === 'g') gAt = Date.now();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [can, navigate]);

  const nav = (
    <nav aria-label="Primary" className="flex flex-col gap-4 px-3 pb-4" data-tour="nav">
      {NAV_GROUPS.map((g) => {
        const items = g.items.filter((n) => can(...n.perms));
        if (!items.length) return null;
        return (
          <div key={g.labelKey}>
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-navfg/50">{t(g.labelKey)}</p>
            <div className="flex flex-col gap-0.5">
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
                  className={({ isActive }) => cx('group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors', isActive ? 'bg-navactive font-medium text-white' : 'text-navfg hover:bg-white/5 hover:text-white')}>
                  {({ isActive }) => <>
                    {isActive && <span className="absolute left-0 top-1.5 h-[calc(100%-12px)] w-1 rounded-r bg-primary" aria-hidden />}
                    <n.icon className={cx('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'opacity-80')} aria-hidden />{t(n.labelKey)}
                  </>}
                </NavLink>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );

  const side = (
    <>
      <div className="px-5 py-5"><Brand /></div>
      {nav}
      <div className="mt-auto px-5 pb-4 pt-2 text-[10px] leading-snug text-navfg/50"><Activity className="mb-1 h-3 w-3" aria-hidden />Fictional hospital. Synthetic records only; not a medical device.</div>
    </>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1">
        <aside className="hidden w-64 shrink-0 flex-col bg-nav md:flex">{side}</aside>
        {open && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
            <button className="absolute inset-0 bg-black/50" aria-label="Close menu" onClick={() => setOpen(false)} />
            <aside className="relative flex h-full w-72 flex-col overflow-y-auto bg-nav">{side}</aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur">
            <div className="flex min-w-0 items-center gap-3">
              <button className="rounded-lg p-1.5 hover:bg-surface2 md:hidden" aria-label="Open menu" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></button>
              <div className="hidden sm:block"><Crumbs /></div>
            </div>
            <div className="flex items-center gap-1">
              {!can('portal.access') && <LivePill />}
              <button onClick={() => setPalette(true)} data-tour="search" aria-label={t('topbar.search')} aria-keyshortcuts="Control+K Meta+K"
                className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-sm text-muted hover:bg-surface2 hover:text-ink">
                <Search className="h-4 w-4" aria-hidden /><span className="hidden w-36 text-left md:inline">{t('common.search')}...</span><kbd className="hidden rounded border border-line px-1 text-[10px] md:inline">Ctrl K</kbd>
              </button>
              {lab.mode === 'vulnerable' && (
                <form action="/api/lab/search-page" method="get" target="_blank" className="hidden 2xl:block"><label className="sr-only-live" htmlFor="gs">Quick search</label><input id="gs" name="q" placeholder="Quick search…" className="w-36 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm" /></form>
              )}
              <NotificationBell />
              <LanguageSwitch />
              <div ref={menuRoot} className="relative" data-tour="help">
                <button onClick={() => setMenu((m) => !m)} aria-haspopup="true" aria-expanded={menu} aria-label={t('topbar.help')} className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink"><CircleHelp className="h-4 w-4" aria-hidden /></button>
                {menu && (
                  <div className="card-shadow absolute right-0 z-50 mt-2 w-60 rounded-xl border border-line bg-surface p-1" role="menu">
                    <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface2" onClick={() => { setMenu(false); setHelp(true); }}><CircleHelp className="h-4 w-4" aria-hidden />{t('shortcuts.title')}<kbd className="ml-auto rounded border border-line px-1 text-[10px]">?</kbd></button>
                    <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface2" onClick={() => { setMenu(false); setTour(true); }}><Play className="h-4 w-4" aria-hidden />{t('shortcuts.tour')}</button>
                  </div>
                )}
              </div>
              <button onClick={toggle} data-tour="theme" className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink" aria-label={dark ? t('topbar.themeLight') : t('topbar.themeDark')} aria-pressed={dark}>{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
              <Link to="/profile" className="flex items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-surface2">
                <Avatar name={user?.fullName ?? '?'} gender={staffGender(user?.fullName ?? '', user?.id)} seed={(user?.staffId ?? user?.id ?? 0) + 40} size="sm" />
                <span className="hidden text-left text-xs leading-tight lg:block"><span className="block font-semibold">{user?.fullName}</span><span className="text-muted">{user?.roleName}</span></span>
              </Link>
              <button onClick={() => void logout()} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted hover:bg-surface2 hover:text-ink" aria-label={t('common.signOut')}><LogOut className="h-4 w-4" /><span className="hidden sm:inline">{t('common.signOut')}</span></button>
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-[1500px] flex-1 p-4 md:p-6"><Outlet /></main>
        </div>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
      <Tour open={tour} onClose={() => setTour(false)} />
    </div>
  );
}
