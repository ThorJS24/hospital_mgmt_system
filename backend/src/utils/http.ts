import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(
      400,
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export interface PageQuery {
  page: number;
  pageSize: number;
  q: string;
  sort: string;
  dir: 'asc' | 'desc';
}

export function pageQuery(query: Record<string, any>, defaultSort = 'id'): PageQuery {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(query.pageSize ?? '15'), 10) || 15));
  return {
    page,
    pageSize,
    q: String(query.q ?? '').trim().slice(0, 100),
    sort: String(query.sort ?? defaultSort),
    dir: query.dir === 'desc' ? 'desc' : 'asc',
  };
}

/** Whitelisted ORDER BY helper; never interpolates raw user input. */
export function orderBy(pq: PageQuery, allowed: Record<string, string>, fallback: string): string {
  const col = allowed[pq.sort] ?? allowed[fallback];
  return `${col} ${pq.dir === 'desc' ? 'DESC' : 'ASC'}`;
}

export function intParam(v: unknown, name = 'id'): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new HttpError(400, `Invalid ${name}`);
  return n;
}
