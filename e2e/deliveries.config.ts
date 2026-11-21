import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "deliveries.spec.ts", workers: 1, use: { baseURL: "http://127.0.0.1:3120", viewport: { width: 1280, height: 800 } }, webServer: { cwd: process.cwd(), command: "npx tsx e2e/deliveries.server.ts", url: "http://127.0.0.1:3120", reuseExistingServer: false } });
