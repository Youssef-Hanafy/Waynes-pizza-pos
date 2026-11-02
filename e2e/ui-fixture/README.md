# POS UI audit harness

Run `npx playwright test -c e2e/ui-audit.config.ts --repeat-each=2` from the repository root.

This loopback-only server bundles the **actual PosApp, OneTab, keyboard, dialogs,
menu, navigation, stores and global CSS**, including the application's Tailwind
and cascade-layer flattening pipeline. It does not load .env files, authenticate,
connect to a database, or provide production mutation endpoints. Browser tests
intercept API calls with synthetic data and block non-loopback requests. Dinner
modifier definitions come from the repository's existing normalized fixture.

It is not the Next.js server: SSR, hydration, deployment asset loading, hosted
font metrics, real Auth/Realtime, native hardware and Android lifecycle are not
covered here. The separate screen-stability suite exercises the real worker and
update manager against simulated deployments. Main `npm run build` validates the
actual Next.js application, but does not substitute for hardware acceptance.

Evidence is written to `docs/elo-ui-audit`; traces stay under ignored
`test-results/ui-audit`. Eight CSS viewport sizes and DPR 1, 1.5 and 2 are test
candidates, not a claim about the store's configured Android display density.
