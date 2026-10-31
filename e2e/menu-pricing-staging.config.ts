import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'menu-pricing-staging.spec.ts',workers:1,outputDir:'pricing-fixture/staging-test-results',use:{baseURL:'https://waynes-pos-staging.vercel.app',trace:'retain-on-failure'},timeout:60_000});
