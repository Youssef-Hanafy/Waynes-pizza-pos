import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores(["test-results/**", "playwright-report/**", ".next/**", "e2e/pricing-fixture/.next/**", "e2e/pricing-fixture/next-env.d.ts", ".open-next/**", ".wrangler/**", "coverage/**", "node_modules/**", "supabase/.temp/**"])
]);
