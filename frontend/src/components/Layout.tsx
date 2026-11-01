import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Activity, BedDouble, Building2, CalendarDays, FlaskConical, LayoutDashboard, LogOut, Menu, Moon, Pill, Receipt, ShieldCheck, Stethoscope, Sun, UserCog, Users, BarChart3, HeartPulse } from 'lucide-react';
import { useAuth, useTheme } from '../lib/auth';
import { useLive } from '../lib/live';
import { Avatar, staffGender } from './Avatar';
import { cx } from './ui';

const GROUPS = [
  { label: 'Overview', items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, perms: ['dashboard.read'] }] },
  {
    label: 'Clinical', items: [
      { to: '/patients', label: 'Patients', icon: Users, perms: ['patients.read_all', 'patients.read_scoped'] },
      { to: '/appointments', label: 'Appointments', icon: CalendarDays, perms: ['appointments.read'] },
      { to: '/admissions', label: 'Admissions', icon: BedDouble, perms: ['admissions.read'] },
      { to: '/laboratory', label: 'Laboratory', icon: FlaskConical, perms: ['lab.read'] },
      { to: '/pharmacy', label: 'Pharmacy', icon: Pill, perms: ['pharmacy.read'] },
    ],
  },
  {
    label: 'Operations', items: [
      { to: '/staff', label: 'Staff', icon: Stethoscope, perms: ['staff.read'] },
      { to: '/departments', label: 'Departments', icon: Building2, perms: ['departments.read'] },
      { to: '/billing', label: 'Billing', icon: Receipt, perms: ['billing.read'] },
      { to: '/reports', label: 'Reports', icon: BarChart3, perms: ['reports.read'] },
    ],
  },
  {
    label: 'System', items: [
      { to: '/admin', label: 'Administration', icon: UserCog, perms: ['users.manage'] },
      { to: '/assessment', label: 'Assessment', icon: ShieldCheck, perms: ['assessment.read'] },
    ],
  },
];

export const firstAllowed = (can: (...p: string[]) => boolean) => GROUPS.flatMap((g) => g.items).find((n) => can(...n.perms))?.to ?? '/profile';

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
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="hidden items-center gap-3 text-xs text-muted lg:flex">
      <span className="tabular-nums" aria-label="Current time">{now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · {now.toLocaleTimeString()}</span>
      <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium', connected ? 'bg-ok/15 text-ok' : 'bg-surface2 text-muted')} role="status">
        <span className={cx('h-1.5 w-1.5 rounded-full', connected ? 'animate-pulse bg-ok' : 'bg-muted')} aria-hidden />{connected ? 'Live' : 'Offline'}
      </span>
    </div>
  );
}


export default function Layout() {
  const { user, can, logout, lab } = useAuth();
  const { dark, toggle } = useTheme();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav aria-label="Primary" className="flex flex-col gap-4 px-3 pb-4">
      {GROUPS.map((g) => {
        const items = g.items.filter((n) => can(...n.perms));
        if (!items.length) return null;
        return (
          <div key={g.label}>
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-navfg/50">{g.label}</p>
            <div className="flex flex-col gap-0.5">
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
                  className={({ isActive }) => cx('group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors', isActive ? 'bg-navactive font-medium text-white' : 'text-navfg hover:bg-white/5 hover:text-white')}>
                  {({ isActive }) => <>
                    {isActive && <span className="absolute left-0 top-1.5 h-[calc(100%-12px)] w-1 rounded-r bg-primary" aria-hidden />}
                    <n.icon className={cx('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'opacity-80')} aria-hidden />{n.label}
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
            <div className="flex items-center gap-3">
              <button className="rounded-lg p-1.5 hover:bg-surface2 md:hidden" aria-label="Open menu" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></button>
              <Crumbs />
            </div>
            <div className="flex items-center gap-1.5">
              <LivePill />
              {lab.mode === 'vulnerable' && (
                <form action="/api/lab/search-page" method="get" target="_blank" className="hidden md:block"><label className="sr-only-live" htmlFor="gs">Quick search</label><input id="gs" name="q" placeholder="Quick search…" className="w-44 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm" /></form>
              )}
              <button onClick={toggle} className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} aria-pressed={dark}>{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
              <Link to="/profile" className="flex items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-surface2">
                <Avatar name={user?.fullName ?? '?'} gender={staffGender(user?.fullName ?? '', user?.id)} seed={(user?.staffId ?? user?.id ?? 0) + 40} size="sm" />
                <span className="hidden text-left text-xs leading-tight sm:block"><span className="block font-semibold">{user?.fullName}</span><span className="text-muted">{user?.roleName}</span></span>
              </Link>
              <button onClick={() => void logout()} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted hover:bg-surface2 hover:text-ink" aria-label="Sign out"><LogOut className="h-4 w-4" /><span className="hidden sm:inline">Sign out</span></button>
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-[1500px] flex-1 p-4 md:p-6"><Outlet /></main>
        </div>
      </div>
    </div>
  );
}
