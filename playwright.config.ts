import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/reorder.spec.ts", "**/menu-pricing.spec.ts", "**/menu-pricing-staging.spec.ts", "**/pricing-fixture/**", "**/screen-stability-local.spec.ts", "**/stability-fixture/**", "**/signature.spec.ts", "**/fulfillment.spec.ts"],
  fullyParallel: false,
  reporter: "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
