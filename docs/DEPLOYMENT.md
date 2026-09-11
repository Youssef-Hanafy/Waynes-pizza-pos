# Deploying Wayne's Pizza POS (audit item H2)

The app is not hosted anywhere yet, and the only Supabase project (`vxpkdmtornkeoedkawkt`) is the one production will use. These steps need accounts only the owner/developer can create, so they are a runbook rather than code. Nothing here requires code changes — domains and keys are environment configuration.

## 1. Put the repository on GitHub (required by Vercel)

The local repo has no remote. Create a **private** GitHub repository, then:

```bash
cd ~/Downloads/waynes-pizza-pos
git remote add origin git@github.com:<you>/waynes-pizza-pos.git
git push -u origin main
```

`.env.local` is git-ignored; confirm with `git status` before the first push.

## 2. Create a staging Supabase project

Staging must be a separate project so test orders never touch Wayne's real data.

1. supabase.com → New project → name `waynes-pos-staging`, region `us-east-1` (closest to Worcester). The free tier is enough for staging.
2. Apply every migration from this repo:
   ```bash
   npx supabase link --project-ref <staging-ref>
   npx supabase db push
   ```
3. Authentication → Providers → Email: **disable "Allow new users to sign up"** (staff are created from `/admin/staff`). Authentication → Password security: **enable leaked-password protection** (audit M5; the setting is only available in the dashboard, and on some plans only on Pro).
4. Load the labelled staging fixture per [`PHASE_0_5_STAGING_ACCEPTANCE.md`](PHASE_0_5_STAGING_ACCEPTANCE.md).

Repeat step 3 on the production project (`vxpkdmtornkeoedkawkt`).

## 3. Create the Vercel project

1. vercel.com → Add New → Project → import the GitHub repository. Framework preset: Next.js. Root directory: repository root. Node.js 22.
2. Environment variables (Settings → Environment Variables). Use the **staging** Supabase values for the Preview environment and the **production** values for Production:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_APP_URL` | `https://<staging or production domain>` |
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL from Supabase → Settings → API |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key — **server only; required for checkout** |
   | `LOG_LEVEL` | `info` |

3. Deploy. Every push to a branch creates a Preview (staging) deployment; `main` deploys Production.
4. Supabase → Authentication → URL Configuration: set Site URL to the deployed domain and add it to Redirect URLs (both projects).

## 4. Bootstrap the owner (each environment)

```bash
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
WAYNES_OWNER_EMAIL=owner@... WAYNES_OWNER_INITIAL_PASSWORD='<12+ chars>' \
npm run seed:owner
```

Then sign in, open `/admin/staff`, and create an individual account for every cashier, cook, and manager.

## 5. Hanafy CRM destination per environment

Production is already wired to `https://www.hanafymedia.com/api/v1/integrations/waynes/events`. For staging, either register a separate signed event source in the CRM or leave the destination **paused** in `/admin/integrations` — since the remediation, paused events are queued, not dropped, so nothing is lost.

## 6. Domain

Confirm who controls the current Wayne's domain registrar (build sheet §2). Point `order.<domain>` (or the apex) at Vercel, then update `NEXT_PUBLIC_APP_URL`, the Supabase Site URL, and `canonical_url` in `/admin/settings`.

## 7. Go-live gate

The dashboard's **Before going live** checklist must be complete (menu, tax rate, delivery ZIPs, fee/minimum, phone, staff sign-ins, Hanafy). Run the staging acceptance runbook and record the evidence before turning off TEST / MANUAL ordering.
