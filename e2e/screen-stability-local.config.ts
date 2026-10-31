import { defineConfig, devices } from "@playwright/test";

/** Local, self-contained screen-stability suite (no staging, no Supabase): `npm run test:screen-stability`. */
const port = Number(process.env.STABILITY_FIXTURE_PORT ?? 4177);
export default defineConfig({
  testDir: ".",
  testMatch: ["screen-stability-local.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 240_000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure", serviceWorkers: "allow" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: `npx tsx e2e/stability-fixture/server.ts`, url: `http://127.0.0.1:${port}/__control/state`, reuseExistingServer: false, env: { PORT: String(port) }, cwd: "..", timeout: 60_000 },
});
