import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', workers: 1, timeout: 180_000,
  expect: { timeout: 30_000 }, reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
