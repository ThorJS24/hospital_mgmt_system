import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { loadConfig, type AppConfig, type LabMode } from '../src/config/index.js';
import { connect, migrate, type Db } from '../src/db/index.js';
import { seedAll, TEST_ACCOUNTS } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { configureLogger } from '../src/utils/logger.js';

export interface Lab { app: ReturnType<typeof createApp>; db: Db; cfg: AppConfig }

export async function makeLab(labMode: LabMode, extra: Partial<AppConfig> = {}): Promise<Lab> {
  configureLogger('error', true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medicore-test-'));
  const cfg: AppConfig = { ...loadConfig({}), labMode, uploadDir: path.join(tmp, 'uploads'), evidenceDir: path.join(tmp, 'evidence'), reportDir: path.join(tmp, 'reports'), ...extra };
  const db = await connect(cfg, true);
  await migrate(db);
  await seedAll(db, cfg);
  return { app: createApp(db, cfg), db, cfg };
}

export const passwordOf = (username: string): string => TEST_ACCOUNTS.find((a) => a.username === username)!.password;

/** Cookie-keeping HTTP client that attaches the session's CSRF token to unsafe requests. */
export class Client {
  agent;
  csrf = '';
  constructor(public lab: Lab) {
    this.agent = request.agent(lab.app);
  }
  async init() {
    const r = await this.agent.get('/api/auth/session');
    this.csrf = r.body.csrfToken;
    return r;
  }
  async login(username: string, password: string = passwordOf(username)) {
    if (!this.csrf) await this.init();
    const r = await this.agent.post('/api/auth/login').set('x-csrf-token', this.csrf).send({ username, password });
    if (r.status === 200 && r.body.csrfToken) this.csrf = r.body.csrfToken;
    return r;
  }
  get(url: string) { return this.agent.get(url); }
  post(url: string, body: unknown = {}) { return this.agent.post(url).set('x-csrf-token', this.csrf).send(body as object); }
  patch(url: string, body: unknown = {}) { return this.agent.patch(url).set('x-csrf-token', this.csrf).send(body as object); }
  put(url: string, body: unknown = {}) { return this.agent.put(url).set('x-csrf-token', this.csrf).send(body as object); }
  delete(url: string) { return this.agent.delete(url).set('x-csrf-token', this.csrf); }
}

export async function as(lab: Lab, username: string) {
  const c = new Client(lab);
  const r = await c.login(username);
  if (r.status !== 200) throw new Error(`login failed for ${username}: ${r.status}`);
  return c;
}

export const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
