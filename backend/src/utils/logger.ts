const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
let threshold: number = LEVELS.info;
let silent = false;

export function configureLogger(level: Level, mute = false) {
  threshold = LEVELS[level];
  silent = mute;
}

const REDACT = /(password|token|secret|cookie|authorization|csrf|sid)/i;

/** Structured JSON logs. Values for sensitive keys are never emitted. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (silent || LEVELS[level] < threshold) return;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = REDACT.test(k) ? '[redacted]' : v;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...safe }) + '\n');
}
