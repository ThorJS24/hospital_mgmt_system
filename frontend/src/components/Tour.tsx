import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { Button } from './ui';

const STEPS = [
  { sel: '[data-tour="nav"]', k: 'nav' },
  { sel: '[data-tour="search"]', k: 'search' },
  { sel: '[data-tour="bell"]', k: 'bell' },
  { sel: '[data-tour="theme"]', k: 'theme' },
  { sel: '[data-tour="help"]', k: 'help' },
] as const;

export const TOUR_KEY = 'medicore-tour-v1';
export const tourSeen = () => { try { return localStorage.getItem(TOUR_KEY) === 'done'; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(TOUR_KEY, 'done'); } catch { /* ignore */ } };

const visible = (sel: string) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
};

/** First-run onboarding tour: highlights real controls, skips any that are hidden on small screens, and never blocks the keyboard. */
export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const [steps, setSteps] = useState<typeof STEPS[number][]>([]);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const next = useRef<HTMLButtonElement>(null);

  const finish = useCallback(() => { markSeen(); onClose(); }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const available = STEPS.filter((s) => visible(s.sel));
    setSteps(available);
    setI(0);
    if (!available.length) finish();
  }, [open, finish]);

  const measure = useCallback(() => {
    const s = steps[i];
    setRect(s ? visible(s.sel) : null);
  }, [steps, i]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open, measure]);

  useEffect(() => { if (open && rect) next.current?.focus(); }, [open, rect, i]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      if (e.key === 'ArrowRight') setI((n) => Math.min(steps.length - 1, n + 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, steps.length, finish]);

  if (!open || !rect || !steps[i]) return null;
  const step = steps[i];
  const last = i === steps.length - 1;
  const pad = 6;
  const cardW = 320;
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - cardW - 12);
  const below = rect.bottom + 14 + 190 < window.innerHeight;
  const top = below ? rect.bottom + 14 : Math.max(12, rect.top - 14 - 190);
  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      <div aria-hidden className="pointer-events-none absolute rounded-xl ring-2 ring-primary"
        style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: '0 0 0 9999px rgba(8,17,28,0.62)' }} />
      <div className="card-shadow absolute rounded-xl border border-line bg-surface p-4" style={{ left, top, width: cardW }}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">{t('tour.title')} - {t('tour.step', { n: i + 1, total: steps.length })}</p>
        <h2 id="tour-title" className="mt-1 text-base font-semibold">{t(`tour.${step.k}.title`)}</h2>
        <p id="tour-body" className="mt-1 text-sm text-muted">{t(`tour.${step.k}.body`)}</p>
        <div className="mt-4 flex items-center justify-between">
          <button className="text-sm text-muted hover:text-ink hover:underline" onClick={finish}>{t('common.skip')}</button>
          <div className="flex gap-2">
            {i > 0 && <Button variant="secondary" onClick={() => setI(i - 1)}>{t('common.back')}</Button>}
            <Button ref={next} onClick={() => (last ? finish() : setI(i + 1))}>{last ? t('common.finish') : t('common.next')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
