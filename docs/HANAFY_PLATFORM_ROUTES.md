# Hanafy Platform — every page and where to find it

Base address: **https://waynes-pizza-pos.vercel.app** (local: `http://localhost:3000`). Once `waynespizzaofworcester.com` points at Vercel, the customer pages answer there too.
Sign in at **/login**. Platform pages need a Hanafy platform account; business pages need a membership in that business.

## Hanafy Platform Admin (you / Hanafy staff)

| Page | What it's for |
|---|---|
| `/platform` | Dashboard: businesses, issues, billing totals, support sessions, recent activity |
| `/platform/workspaces` | All businesses (status, services, messaging, payments, devices, billing, health) + **Add business** |
| `/platform/workspaces/new` | Add a business (Phase 12) |
| `/platform/billing` | Hanafy billing across all businesses, overdue invoices, plans (Phase 11) |
| `/platform/audit` | Platform-wide audit log |
| `/platform/workspaces/waynes-pizza` | Business overview (swap `waynes-pizza` for any business's web name) |
| `…/setup` | Setup checklist, activate / suspend / archive (Phase 12) |
| `…/services` | Turn services on/off |
| `…/users` | Owner and staff accounts |
| `…/messaging` | SMS number, AWS connection, automations cut-over |
| `…/integrations` | Payment connections (Boston North manual terminal) and all integrations |
| `…/domains` | Web addresses + website basics and brand colour (Phase 13) |
| `…/hardware` | Devices: printers, drawer, caller-ID box, router, AP, terminal; health (Phase 10) |
| `…/billing` | Agreement, invoices, payments (Phase 11) |
| `…/equipment` | Hanafy-supplied equipment and balances (Phase 11) |
| `…/health` | Live problems: CRM events, printing, payments, caller ID, devices |
| `…/audit` | This business's audit trail (incl. Hanafy support actions) |

## Business workspace (owner / managers)

| Page | What it's for |
|---|---|
| `/w` | Pick a business (if you belong to more than one) |
| `/w/waynes-pizza` | Workspace home with module-aware navigation |
| `/w/waynes-pizza/billing` | "Hanafy bill": what the business owes Hanafy (Phase 11) |

## Wayne's back office (`/admin`)

`/admin` (dashboard) · `/admin/orders` · `/admin/orders/<id>` · `/admin/calendar` · `/admin/delivery` · `/admin/cash` · `/admin/payments` · `/admin/customers` · `/admin/customers/<id>` · `/admin/segments` · `/admin/promotions` · `/admin/marketing` · `/admin/marketing/campaigns/<id>` · `/admin/automations` · `/admin/automations/<id>` · `/admin/reports` · `/admin/menu` · `/admin/menu/new` · `/admin/menu/items/<id>` · `/admin/menu/photos` · `/admin/settings` (website & hours) · `/admin/printing` · `/admin/hardware` (settings + devices on record) · `/admin/pilot` · `/admin/integrations` · `/admin/staff` · `/admin/audit`

## Store floor

`/pos` (register, phone orders, caller ID) · `/kitchen` (kitchen screen) · `/driver` (delivery driver)

## Customer website

`/` · `/menu` · `/order` · `/checkout` · `/order/<id>?token=…` (confirmation) · `/rewards` (Wayne's Rewards sign-up) · `/offers` · `/r/<key>` (personal offer link) · `/about` · `/contact` · `/terms` · `/privacy` · `/sitemap.xml` · `/robots.txt`

## Sign-in

`/login` · `/unauthorized`
