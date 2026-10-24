#!/bin/bash
# Vercel "Ignored Build Step" (owner, 2026-10-24: "optimize the Vercel … and
# GitHub" — fewer builds).  Exit 0 = skip this build, exit 1 = build it.
#
#   * Only main deploys.  Other branches (Codex work branches, etc.) don't
#     build a preview; merge to main to ship.
#   * A push that changes nothing the website runs on (the Android app, docs,
#     database migrations, scripts, tests, notes) doesn't rebuild the site.
# When in doubt it builds.

if [ "$VERCEL_GIT_COMMIT_REF" != "main" ]; then
  echo "Skipping: only main is deployed (branch ${VERCEL_GIT_COMMIT_REF:-unknown})."
  exit 0
fi

BASE="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
if ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  echo "Building: previous deploy not in this checkout."
  exit 1
fi

if git diff --quiet "$BASE" HEAD -- . \
  ':(exclude)android' ':(exclude)docs' ':(exclude)supabase' ':(exclude)scripts' \
  ':(exclude)tests' ':(exclude)e2e' ':(exclude)*.md' ':(exclude)*.apk' \
  ':(exclude)Claude outputs' ':(exclude)PUSH TO GITHUB.command' ':(exclude)tools'; then
  echo "Skipping: nothing the website runs on changed since the last deploy."
  exit 0
fi

echo "Building."
exit 1
