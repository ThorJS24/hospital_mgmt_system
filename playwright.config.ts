import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// a fresh embedded database for every run, so the tests never depend on leftovers of a previous run
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medicore-e2e-'));

// E2E runs against a throw-away embedded database on loopback only. Locally it drives the installed Microsoft Edge;
// in CI (CI=true) it uses the Chromium that `npx playwright install chromium` provides.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5173', ...(process.env.CI ? {} : { channel: 'msedge' as const }), trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'npm run start -w backend',
      url: 'http://127.0.0.1:4000/api/health',
      env: { LAB_MODE: 'vulnerable', HOST: '127.0.0.1', PORT: '4000', PGLITE_DIR: dbDir, LOG_LEVEL: 'warn', LIVE_SIM: '0' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    { command: 'npm run dev -w frontend', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 60_000 },
  ],
});
