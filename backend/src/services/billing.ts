export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const calcTotal = (items: { quantity: number; unit_price: number }[]) =>
  round2(items.reduce((s, i) => s + i.quantity * i.unit_price, 0));

export const calcBalance = (total: number, paid: number) => Math.max(0, round2(total - paid));

export function deriveStatus(total: number, paid: number): 'Issued' | 'Partially paid' | 'Paid' {
  if (paid <= 0) return 'Issued';
  return round2(total - paid) <= 0 ? 'Paid' : 'Partially paid';
}
