import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Info, Loader2, X, XCircle, ArrowUp, ArrowDown, Inbox } from 'lucide-react';
import { ApiError, get, qs } from '../lib/api';
import { useLiveTick } from '../lib/live';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- buttons / cards ----------
export function Button({ variant = 'primary', loading, className, children, disabled, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean }) {
  const v = {
    primary: 'bg-primary text-primaryfg hover:brightness-110',
    secondary: 'bg-surface text-ink border border-line shadow-none hover:bg-surface2',
    danger: 'bg-danger text-white hover:opacity-90',
    ghost: 'text-ink shadow-none hover:bg-surface2',
  }[variant];
  return (
    <button {...p} disabled={disabled || loading} className={cx('inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium shadow-sm transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50', v, className)}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export const Card = ({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={cx('card-shadow rounded-xl border border-line bg-surface', className)}>
    {(title || actions) && (
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <div className="flex gap-2">{actions}</div>
      </header>
    )}
    <div className="p-4">{children}</div>
  </section>
);

// ---------- status badges (icon + text, never colour alone) ----------
const TONES: Record<string, { cls: string; icon: ReactNode }> = {
  ok: { cls: 'bg-ok/15 text-ok', icon: <CheckCircle2 className="h-3 w-3" aria-hidden /> },
  warn: { cls: 'bg-warn/15 text-warn', icon: <AlertTriangle className="h-3 w-3" aria-hidden /> },
  danger: { cls: 'bg-danger/15 text-danger', icon: <XCircle className="h-3 w-3" aria-hidden /> },
  info: { cls: 'bg-info/15 text-info', icon: <Info className="h-3 w-3" aria-hidden /> },
  neutral: { cls: 'bg-surface2 text-muted', icon: <CircleDashed className="h-3 w-3" aria-hidden /> },
};
const STATUS_TONE: Record<string, string> = {
  Active: 'ok', Completed: 'ok', Paid: 'ok', Approved: 'ok', Dispensed: 'ok', Available: 'ok', Discharged: 'neutral', Confirmed: 'info', 'Checked in': 'info', 'In consultation': 'info',
  Scheduled: 'neutral', Issued: 'info', 'Partially paid': 'warn', Pending: 'warn', Requested: 'warn', 'In progress': 'info', Resulted: 'info', Admitted: 'info', Partially_dispensed: 'warn',
  'Partially dispensed': 'warn', Cancelled: 'danger', 'No-show': 'danger', Inactive: 'neutral', Deceased: 'danger', Draft: 'neutral', 'In Surgery': 'warn', 'On Leave': 'warn', 'Off Duty': 'neutral',
  Critical: 'danger', High: 'danger', Medium: 'warn', Low: 'info', Informational: 'neutral', Mild: 'info', Moderate: 'warn', Severe: 'danger',
  'Not Tested': 'neutral', Planned: 'neutral', 'Under Assessment': 'info', Confirmed_: 'danger', 'False Positive': 'neutral', 'Not Reproduced': 'neutral', 'Remediation Proposed': 'warn', Remediated: 'info', 'Retest Passed': 'ok', 'Retest Failed': 'danger',
  reproduced: 'danger', 'not-reproduced': 'neutral', pass: 'ok', fail: 'danger', pending: 'neutral',
};
export function StatusBadge({ status, tone }: { status: string | null | undefined; tone?: keyof typeof TONES }) {
  const label = status ?? 'Pending';
  const t = TONES[tone ?? STATUS_TONE[label === 'Confirmed' ? 'Confirmed_' : label] ?? 'neutral'];
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', t.cls)}>{t.icon}{label}</span>;
}

// ---------- alerts / toasts ----------
export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'warn' | 'info' | 'ok'; children: ReactNode }) {
  const t = TONES[tone];
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-md border border-line px-3 py-2 text-sm', t.cls)}><span className="mt-0.5">{t.icon}</span><div>{children}</div></div>;
}
export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong');

const ToastCtx = createContext<(m: string, tone?: 'ok' | 'danger') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; m: string; tone: 'ok' | 'danger' }[]>([]);
  const push = useCallback((m: string, tone: 'ok' | 'danger' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, m, tone }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2" aria-live="polite" aria-atomic="false">
        {items.map((i) => <div key={i.id} className="shadow-lg"><Alert tone={i.tone}>{i.m}</Alert></div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <div role="status" className="flex items-center justify-center gap-2 py-10 text-muted"><Loader2 className="h-5 w-5 animate-spin" aria-hidden />{label}…</div>
);
export const EmptyState = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="flex flex-col items-center gap-1 py-10 text-center text-muted"><Inbox className="h-8 w-8" aria-hidden /><p className="font-medium text-ink">{title}</p>{hint && <p>{hint}</p>}</div>
);

// ---------- forms ----------
interface FieldBase { label: string; error?: string; hint?: string; required?: boolean }
const fieldCls = 'w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-primary';
function FieldShell({ label, error, hint, required, id, children }: FieldBase & { id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">{label}{required && <span className="text-danger" aria-hidden> *</span>}{required && <span className="sr-only-live"> required</span>}</label>
      {children}
      {hint && !error && <p id={`${id}-h`} className="text-xs text-muted">{hint}</p>}
      {error && <p id={`${id}-e`} role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}
export function TextField({ label, error, hint, required, className, ...p }: FieldBase & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return <FieldShell {...{ label, error, hint, required, id }}><input id={id} required={required} aria-invalid={!!error} aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined} className={cx(fieldCls, error && 'border-danger', className)} {...p} /></FieldShell>;
}
export function SelectField({ label, error, hint, required, children, ...p }: FieldBase & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return <FieldShell {...{ label, error, hint, required, id }}><select id={id} required={required} aria-invalid={!!error} className={cx(fieldCls, error && 'border-danger')} {...p}>{children}</select></FieldShell>;
}
export function TextArea({ label, error, hint, required, ...p }: FieldBase & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return <FieldShell {...{ label, error, hint, required, id }}><textarea id={id} rows={3} required={required} aria-invalid={!!error} className={cx(fieldCls, error && 'border-danger')} {...p} /></FieldShell>;
}
/** Maps API validation details to a field-keyed error record. */
export const fieldErrors = (e: unknown): Record<string, string> =>
  e instanceof ApiError && e.details ? Object.fromEntries(e.details.map((d) => [d.field, d.message])) : {};

// ---------- modal (native <dialog>: focus trap + Esc handled by the browser) ----------
export function Modal({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={tid} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-lg border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/50', wide ? 'max-w-3xl' : 'max-w-lg')}>
      {open && (
        <div>
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 id={tid} className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Close dialog" className="rounded p-1 hover:bg-surface2"><X className="h-4 w-4" /></button>
          </header>
          <div className="max-h-[75vh] overflow-y-auto p-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === t.id ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink')}>{t.label}</button>
      ))}
    </div>
  );
}

// ---------- data fetching ----------
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    set((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => live && set({ data, loading: false, error: null })).catch((e) => live && set({ data: null, loading: false, error: errMsg(e) }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export interface ListState { page: number; q: string; sort: string; dir: 'asc' | 'desc'; filters: Record<string, string> }
export function useList<T>(url: string, initialSort = '', pageSize = 15) {
  const [s, setS] = useState<ListState>({ page: 1, q: '', sort: initialSort, dir: 'asc', filters: {} });
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(s.q), 250); return () => clearTimeout(t); }, [s.q]);
  const query = qs({ page: s.page, pageSize, q: debouncedQ, sort: s.sort, dir: s.dir, ...s.filters });
  const tick = useLiveTick();
  const res = useAsync(() => get<{ data: T[]; total: number; page: number; pageSize: number }>(`${url}${query}`), [url, query, tick]);
  return {
    ...res, rows: res.data?.data ?? [], total: res.data?.total ?? 0, state: s, pageSize,
    setPage: (page: number) => setS((p) => ({ ...p, page })),
    setQ: (q: string) => setS((p) => ({ ...p, q, page: 1 })),
    setFilter: (k: string, v: string) => setS((p) => ({ ...p, page: 1, filters: { ...p.filters, [k]: v } })),
    toggleSort: (k: string) => setS((p) => ({ ...p, sort: k, dir: p.sort === k && p.dir === 'asc' ? 'desc' : 'asc' })),
  };
}

// ---------- table ----------
export interface Column<T> { key: string; label: string; sortKey?: string; render?: (r: T) => ReactNode; className?: string }
export function DataTable<T extends { id: number | string }>({ list, columns, onRowClick, empty = 'No records found', actions, caption }: {
  list: ReturnType<typeof useList<T>>; columns: Column<T>[]; onRowClick?: (r: T) => void; empty?: string; actions?: (r: T) => ReactNode; caption: string;
}) {
  const { rows, loading, error, state, total, pageSize } = list;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cell = (c: Column<T>, r: T) => (c.render ? c.render(r) : String((r as any)[c.key] ?? '—'));
  return (
    <div>
      {error ? <Alert>{error}</Alert> : loading && !rows.length ? <Spinner /> : !rows.length ? <EmptyState title={empty} hint={state.q || Object.values(state.filters).some(Boolean) ? 'Try clearing the search or filters.' : undefined} /> : (
        <>
          <div className="hidden overflow-x-auto md:block" aria-busy={loading}>
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only-live">{caption}</caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className={cx('px-3 py-2 font-semibold', c.className)} aria-sort={c.sortKey && state.sort === c.sortKey ? (state.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {c.sortKey ? <button className="inline-flex items-center gap-1 uppercase hover:text-ink" onClick={() => list.toggleSort(c.sortKey!)}>{c.label}{state.sort === c.sortKey && (state.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}</button> : c.label}
                    </th>
                  ))}
                  {actions && <th scope="col" className="px-3 py-2"><span className="sr-only-live">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={cx('border-b border-line last:border-0 even:bg-surface2/30', onRowClick && 'cursor-pointer hover:bg-primary/5')} onClick={() => onRowClick?.(r)}>
                    {columns.map((c, i) => <td key={c.key} className={cx('px-3 py-2 align-middle', c.className)}>{i === 0 && onRowClick ? <button className="text-left font-medium text-primary hover:underline" onClick={(e) => { e.stopPropagation(); onRowClick(r); }}>{cell(c, r)}</button> : cell(c, r)}</td>)}
                    {actions && <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>{actions(r)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden">
            {rows.map((r) => (
              <li key={r.id} className="rounded-md border border-line p-3" onClick={() => onRowClick?.(r)}>
                <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-sm">
                  {columns.map((c) => <div key={c.key} className="contents"><dt className="text-muted">{c.label}</dt><dd className="break-words">{cell(c, r)}</dd></div>)}
                </dl>
                {actions && <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>{actions(r)}</div>}
              </li>
            ))}
          </ul>
          <nav aria-label="Pagination" className="mt-3 flex items-center justify-between text-sm text-muted">
            <span>{total} record{total === 1 ? '' : 's'} · page {state.page} of {pages}</span>
            <span className="flex gap-1">
              <Button variant="secondary" aria-label="Previous page" disabled={state.page <= 1} onClick={() => list.setPage(state.page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="secondary" aria-label="Next page" disabled={state.page >= pages} onClick={() => list.setPage(state.page + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </span>
          </nav>
        </>
      )}
    </div>
  );
}

export function Toolbar({ list, placeholder = 'Search', children }: { list: { state: ListState; setQ: (q: string) => void }; placeholder?: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3">
      <TextField label="Search" type="search" value={list.state.q} onChange={(e) => list.setQ(e.target.value)} placeholder={placeholder} className="w-64" />
      {children}
    </div>
  );
}

export const KV = ({ label, children }: { label: string; children: ReactNode }) => (
  <div><dt className="text-xs font-medium text-muted">{label}</dt><dd className="mt-0.5 break-words">{children ?? '—'}</dd></div>
);

export function PageHeader({ title, subtitle, actions, image, leading }: { title: string; subtitle?: string; actions?: ReactNode; image?: string; leading?: ReactNode }) {
  if (image) {
    return (
      <div className="card-shadow relative mb-4 overflow-hidden rounded-xl border border-line">
        <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover object-[center_30%]" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#0b1f33f2] via-[#0b1f33b3] to-[#0b1f3366]" aria-hidden />
        <div className="relative flex flex-wrap items-end justify-between gap-3 p-6 text-white">
          <div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{subtitle && <p className="mt-0.5 text-white/75">{subtitle}</p>}</div>
          <div className="flex flex-wrap gap-2">{actions}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-4">{leading}<div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{subtitle && <p className="mt-0.5 text-muted">{subtitle}</p>}</div></div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

export function StatCard({ label, value, sub, icon: Icon, tone = 'primary' }: { label: string; value: string | number; sub?: string; icon: React.ComponentType<{ className?: string }>; tone?: 'primary' | 'ok' | 'warn' | 'info' | 'danger' }) {
  const t = { primary: 'bg-primary/12 text-primary', ok: 'bg-ok/15 text-ok', warn: 'bg-warn/15 text-warn', info: 'bg-info/15 text-info', danger: 'bg-danger/15 text-danger' }[tone];
  return (
    <div className="card-shadow flex items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4">
      <div><p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p><p className="mt-1.5 text-3xl font-semibold tracking-tight">{value}</p>{sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}</div>
      <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', t)}><Icon className="h-5 w-5" aria-hidden /></span>
    </div>
  );
}
