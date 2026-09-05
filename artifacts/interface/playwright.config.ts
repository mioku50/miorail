import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5187', headless: true },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 5187',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: !process.env.CI,
  },
});
