import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'reorder.spec.ts', outputDir: '../test-results/reorder',
  workers: 1, timeout: 30_000, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4188', viewport: { width: 1280, height: 720 }, hasTouch: true, trace: 'retain-on-failure' },
  webServer: { cwd: process.cwd(), command: 'npx tsx e2e/ui-fixture/server.ts', url: 'http://127.0.0.1:4188/pos', reuseExistingServer: false, timeout: 60_000 },
});
