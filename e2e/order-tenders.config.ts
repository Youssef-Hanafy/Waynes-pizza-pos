import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "order-tenders.spec.ts", workers: 1, use: { baseURL: "http://127.0.0.1:3118" }, webServer: { cwd: process.cwd(), command: "npx tsx e2e/order-tenders.server.ts", url: "http://127.0.0.1:3118", reuseExistingServer: false } });
