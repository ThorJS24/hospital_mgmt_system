import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, type ScryptOptions } from 'node:crypto';

/**
 * scrypt with the work factor stored in every hash ("scrypt$N$r$p$salt$key") so cost can be raised later and old hashes still
 * verify. OWASP: N=2^17,r=8,p=1 or the equivalent N=2^16,r=8,p=2 (used here, ~64 MiB). Hashes created before this format
 * ("scrypt$salt$key", N=16384,r=8,p=1) are still accepted and are upgraded at the next successful sign-in (see needsRehash).
 * SCRYPT_LOG_N lowers the cost for the test-suite only.
 */
const R = 8;
const KEYLEN = 32;
const targetLogN = () => { const n = Number(process.env.SCRYPT_LOG_N); return Number.isInteger(n) && n >= 10 && n <= 20 ? n : 16; };
const targetP = () => (targetLogN() >= 16 ? 2 : 1);

const derive = (password: string, salt: Buffer, N: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const opts: ScryptOptions = { N, r, p, maxmem: 256 * 1024 * 1024 };
    scryptCb(password, salt, KEYLEN, opts, (e, key) => (e ? reject(e) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 2 ** targetLogN(), p = targetP();
  return `scrypt$${N}$${R}$${p}$${salt.toString('hex')}$${(await derive(password.normalize('NFKC'), salt, N, R, p)).toString('hex')}`;
}

interface Parsed { N: number; r: number; p: number; salt: Buffer; key: Buffer; legacy: boolean }
function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3) return { N: 16384, r: 8, p: 1, salt: Buffer.from(parts[1], 'hex'), key: Buffer.from(parts[2], 'hex'), legacy: true };
  if (parts.length !== 6) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N < 1024 || N > 2 ** 20 || r < 1 || r > 16 || p < 1 || p > 16) return null;
  return { N, r, p, salt: Buffer.from(parts[4], 'hex'), key: Buffer.from(parts[5], 'hex'), legacy: false };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parse(stored);
  if (!h || !h.salt.length || !h.key.length) return false;
  // legacy hashes were made without Unicode normalisation; try both forms so nobody is locked out by the upgrade
  const candidates = h.legacy ? [...new Set([password, password.normalize('NFKC')])] : [password.normalize('NFKC')];
  for (const c of candidates) {
    const key = await derive(c, h.salt, h.N, h.r, h.p);
    if (key.length === h.key.length && timingSafeEqual(key, h.key)) return true;
  }
  return false;
}

/** True when the stored hash uses an older format or a lower work factor than the current target. */
export function needsRehash(stored: string): boolean {
  const h = parse(stored);
  return !h || h.legacy || h.N < 2 ** targetLogN() || h.p < targetP();
}

let dummy: Promise<string> | null = null;
/** Verifies against a throw-away hash so that unknown usernames cost the same time as wrong passwords. */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(12).toString('hex'));
  await verifyPassword(password, await dummy);
  return false;
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('hex');
export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
/** Constant-time string comparison (length is not leaked: both sides are hashed first). */
export const safeEqual = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
