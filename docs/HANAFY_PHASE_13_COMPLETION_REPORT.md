# Hanafy Platform: Phase 13 completion report (multi-tenant storefront / custom domains)

**Date:** 2026-09-29
**Builds on:** Phase 12
**Migration:** `20261015080000_phase13_multi_tenant_storefront.sql` (applied to live Supabase)
**Status:** **Phase 13 passed** (database acceptance proven by tests; typecheck + lint clean), subject to `npm run verify` on the Mac.

## 1. What was built

Host → `workspace_domains` → workspace + location → settings / menu / deals / theme (§13).

| Area | Before | Now |
|---|---|---|
| Public menu | `wayne_public_menu()` returned every business's menu | `hanafy_public_menu(host)`: only the menu of the business that owns the host; unknown host → empty |
| Public deals | `wayne_public_promotions()` global | `hanafy_public_promotions(host)` scoped the same way |
| Order confirmation page | answered on any host | `hanafy_public_order_status(host, …)` answers only for that business's orders |
| Personal offer links `/r/…` | any host with SMS on | 404 unless the host belongs to the business those links serve |
| Theme | fixed colours | business brand colour (`workspace_settings.brand_colors.primary`) replaces the accent on its own storefront |
| Resolution | settings + workspace | one helper `hanafy_host_workspace(host)`: active business, active location, active address only |
| Platform Admin | domains listed read-only | **Domains & website** tab: add (validated, unique across businesses, Hanafy's own hosts refused), make main, switch on/off (confirmation if it's a live business's last address), remove (only once off); **Website basics** per location (name, headlines, about, contact, search title/description, announcement, footer, ordering open/closed, brand colour) — whitelisted fields only, audited |

Already in place and verified: unknown domains get "Store unavailable"/404 and `noindex` robots; SEO title/description/canonical/sitemap come from the host's own settings; caches are keyed by host (`cache(host)`), every storefront page is dynamic; public order/checkout/Rewards writes only act for the host's own business.

## 2. Acceptance — two domains, two businesses, no leakage

Test `hanafy-phase13-storefront-domains.test.ts` sets up Wayne's (`waynespizzaofworcester.com`) and a second business (`orders.bobs-bagels.example`):
- Before the second business is live, its address resolves to nothing (and never to Wayne's).
- Once live: each host returns its own name, SEO title, canonical URL, menu (only its categories/items), deals (only its codes) and theme; neither sees the other's.
- Wayne's order confirmation is refused on Bob's host and on an unknown host.
- Live check on production data: `hanafy_public_menu('waynespizzaofworcester.com')` is identical to the old menu (18 categories) and the deals are identical; an unknown host returns `[]`.

## 3. Tests

| Check | Result |
|---|---|
| `tests/hanafy-phase13-storefront-domains.test.ts` (6) | **pass** |
| `src/lib/platform/domains.test.ts` (2) | **pass** |
| `tsc --noEmit` / `eslint src` | **0 errors / 0 problems** |

## 4. Manual steps

To put a new business on its own address: Platform Admin → the business → **Domains & website** → add `orders.theirdomain.com` → in Vercel add the same domain to the project and set the DNS record Vercel shows. It starts answering once the business is activated.

## 5. Known limitations

- Online ordering, card checkout and Rewards sign-up still run on the pre-platform order functions, so they are only switched on for Wayne's; another business's storefront shows its info, menu and deals but ordering answers "not available here yet" (Phase 5 guard, unchanged).
- The full Website & hours editor is still Wayne's admin screen; other businesses use the Website basics form above.

## Next

Phase 14: Wayne's full regression and production hardening.
