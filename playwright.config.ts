import { defineConfig, devices } from '@playwright/test';

const PORT = 3050;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Block SW registration in tests: in dev mode, the SW caches Turbopack
    // chunks that change every reload, leading to stale-JS / stale-HTML
    // mismatches on the second visit to a route within one test.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `next dev --port ${PORT}`,
    port: PORT,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
