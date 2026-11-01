import { useState } from 'react';
import { cx } from './ui';

const FEMALE_FIRST = new Set(['Helena', 'Laila', 'Ingrid', 'Camila', 'Mei', 'Nora', 'Amara', 'Hana', 'Giulia', 'Sofia', 'Elsa', 'Priya', 'Priya']);
export const staffGender = (name: string, id = 0): 'f' | 'm' => {
  const first = name.replace(/^Dr\.\s*/, '').split(' ')[0];
  return FEMALE_FIRST.has(first) ? 'f' : first ? 'm' : id % 2 ? 'f' : 'm';
};
export const sexToGender = (sex: string | undefined, id: number): 'f' | 'm' => (sex === 'Female' ? 'f' : sex === 'Male' ? 'm' : id % 2 ? 'f' : 'm');
export const isChild = (dob?: string | null) => !!dob && Date.now() - new Date(dob).getTime() < 15 * 365.25 * 86400000;

const initialsOf = (n: string) => n.replace(/^Dr\.\s*/, '').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const SIZES = { xs: 'h-7 w-7 text-[10px]', sm: 'h-9 w-9 text-xs', md: 'h-12 w-12 text-sm', lg: 'h-20 w-20 text-xl' };

/** Portrait from the bundled placeholder set (/img/people); falls back to initials. Children always get initials. */
export function Avatar({ name, gender, seed, size = 'sm', child = false, className }: { name: string; gender: 'f' | 'm'; seed: number; size?: keyof typeof SIZES; child?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = `/img/people/${gender}${(seed * 7 + 3) % 40}.jpg`;
  const base = cx('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 font-semibold text-primary ring-2 ring-surface', SIZES[size], className);
  if (child || failed) return <span className={base} aria-hidden>{initialsOf(name)}</span>;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={cx(base, 'object-cover')} />;
}
