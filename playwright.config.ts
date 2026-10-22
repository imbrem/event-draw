import { defineConfig } from '@playwright/test';

const baseURL = process.env.TEST_BASE_URL ?? (process.env.CI ? 'http://127.0.0.1:4173/' : 'http://localhost:5173/');

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    viewport: { width: 1100, height: 950 },
    acceptDownloads: true,
    serviceWorkers: 'block',
  },
  webServer: process.env.CI ? {
    command: 'pnpm preview --host 127.0.0.1 --port 4173',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  } : undefined,
  projects: [
    { name: 'chrome', use: { browserName: 'chromium', channel: process.env.CI ? undefined : 'chrome' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
