import { describe, expect, it } from 'vitest';
import { money, qs, toBase64 } from './api';

describe('api helpers', () => {
  it('builds query strings and drops empty values', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: 'x y' })).toBe('?a=1&d=x+y');
    expect(qs({})).toBe('');
  });
  it('formats currency consistently', () => {
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(null)).toBe('-');
  });
  it('base64-encodes bytes', () => {
    expect(toBase64(new TextEncoder().encode('hi').buffer as ArrayBuffer)).toBe('aGk=');
  });
});
