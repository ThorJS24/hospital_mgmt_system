import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000, hookTimeout: 120000, pool: 'forks', env: { SCRYPT_LOG_N: '12' } },
});
