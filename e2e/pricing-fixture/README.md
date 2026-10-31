# Local menu pricing browser fixture

Run `npm run test:menu-pricing:e2e` from the repository root. It starts a fresh
embedded PostgreSQL cluster, applies every repository migration, loads normalized
read-only production dinner configurations, and starts a separate Next.js app on
127.0.0.1:3107. It does not read a database URL, modify staging, or load production
environment files.

The admin page, form, Server Actions, POS item dialog, online menu/customizer and
cart pricing come from the real application source. A small local PostgREST
transport executes SQL in PostgreSQL. Only the Supabase client connection and
staff sign-in/PIN gate are substituted. SQL regression tests separately exercise
actual owner/cashier and cross-workspace authorization. The POS fixture submits
the actual `wayne_create_pos_order` function and reads its saved order-line cents.
It does not exercise card readers, real payments, Elo hardware, Supabase Auth,
Vercel, or the production domain resolver.

The no-plugin PostCSS configuration keeps the fixture independent of the main
app's custom Turbopack CSS pipeline. This is functional browser coverage, not a
visual styling test. The server refuses a non-loopback fixture database endpoint.
