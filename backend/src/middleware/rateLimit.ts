import type { Request, RequestHandler } from 'express';
import { HttpError } from '../utils/http.js';
import { log } from '../utils/logger.js';

interface Bucket { count: number; resetAt: number }

/**
 * Fixed-window, in-memory request limiter (no dependency). Per process: with several instances put a shared limiter at the
 * proxy as well. Returns 429 with Retry-After. Old buckets are pruned on a timer that never keeps the process alive.
 */
export function createRateLimiter(opts: { max: number; windowMs: number; name: string; key?: (req: Request) => string }): RequestHandler & { reset: () => void } {
  const buckets = new Map<string, Bucket>();
  const prune = setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k); }, Math.min(opts.windowMs, 60_000));
  prune.unref();
  const handler: RequestHandler = (req, res, next) => {
    const now = Date.now();
    const key = opts.key ? opts.key(req) : req.ip ?? 'unknown';
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + opts.windowMs }; buckets.set(key, b); }
    b.count++;
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.max - b.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((b.resetAt - now) / 1000)));
    if (b.count > opts.max) {
      const wait = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(wait));
      if (b.count === opts.max + 1) log('warn', 'rate_limited', { limiter: opts.name, key, path: req.path });
      return next(new HttpError(429, `Too many requests. Try again in ${wait} seconds.`));
    }
    next();
  };
  return Object.assign(handler, { reset: () => buckets.clear() });
}
