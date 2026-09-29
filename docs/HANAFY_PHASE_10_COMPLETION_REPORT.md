# Hanafy Platform: Phase 10 completion report (hardware / device administration)

**Date:** 2026-09-29
**Builds on:** Phase 9
**Migration:** `20261012080000_phase10_hardware_devices.sql` (applied to live Supabase `vxpkdmtornkeoedkawkt`)
**Status:** **Phase 10 passed** (database acceptance proven by tests; typecheck + lint clean), subject to `npm run verify` on the Mac.

## 1. What was built

| Area | What it does |
|---|---|
| Device registry (§21.1) | `hardware_devices`: type, name, vendor, model, serial, asset tag, status (planned/active/inactive/retired), ownership (business owns / Hanafy owns / financed / leased / not recorded), connection, IP, MAC, protocol, port, assigned service, notes, configuration (no secrets – `HARDWARE_SECRET_REFUSED`). Never deleted: retired devices keep their history. |
| Registry follows Admin → Hardware | Saving the business's hardware settings (new or old screen) creates/updates the receipt printer, kitchen printer(s), cash drawer and caller-ID box. Removed from settings → *inactive*, not deleted. Serial, asset tag, ownership and notes recorded in Platform Admin survive those updates. The POS, print station and caller-ID bridge still read the same settings as before. |
| Honest health (§21.4) | `ok` / `stale` / `error` / `unknown` (never seen) / `not_monitored` / `off`. Health only comes from real activity: printed or failed print jobs (drawer-kick jobs count for the drawer), **real** caller-ID rings (simulated ones don't count) and `hanafy_hardware_heartbeat` (server only, for bridges/Android). Router, access point and the Boston North terminal are *not monitored* and can never show online. |
| Caller-ID lines & events (§22) | `location_caller_lines.caller_id_device_id` (the §22 `phone_lines` table), only a caller-ID device at the same location; `phone_calls.phone_line_id` set automatically on every ring and backfilled. |
| Payment terminal link | `payment_terminals.hardware_device_id` FK; Wayne's Boston North terminal is linked to its device record. |
| Platform Admin → **Hardware** tab | Devices by location with ownership, model/serial/tag, network, lines, card-terminal link, last seen, last problem; add / change / retire (reason required, audited in both logs). Settings-managed devices refuse address/port/type/location edits ("change it in Admin → Hardware"). |
| Dashboard / Overview / Health | Workspace summary + health now include device counts; a device reporting a problem raises a "hardware_error" issue on the dashboard. |
| Business side | Admin → Hardware now lists "Devices on record" with health (read-only). |

## 2. Wayne's hardware migrated (live)

Front counter Epson TM-T20III (10.10.10.161:9100, business-owned) · Kitchen Epson TM-U220B (10.10.10.171:9100, last printed 2026-09-22 → *stale*) · Cash drawer on the TM-T20III DK port · Caller ID box, CallerID.com Whozz Calling? Basic POS 2 (UDP 3520, serves Line 1 and Line 2, *never seen* until the real bridge runs) · MikroTik router and EnGenius access point (not monitored) · Counter card terminal (Boston North, not monitored, ownership still to confirm).

## 3. Existing behaviour preserved

Admin → Hardware form, `wayne_pos_hardware_settings`, the phone board, print station claims, drawer kick and the Phase 4 legacy mirrors are unchanged; adapters (`CallerIdProvider`, printer, drawer, payment provider) are untouched.

## 4. Files

**New:** migration, `src/lib/platform/hardware.ts`, `src/lib/platform/money.ts`, `src/app/platform/workspaces/[workspaceSlug]/hardware/page.tsx`, `tests/hanafy-phase10-hardware-devices.test.ts`.
**Changed:** `src/app/platform/actions.ts` (`saveHardwareDevice`), `src/lib/platform/{queries,schemas}.ts`, workspace layout (Hardware tab), overview + health pages, `src/app/admin/hardware/page.tsx`, `src/lib/hardware/queries.ts`.

## 5. Database / RLS

`hardware_devices`: members with `hardware.manage` (or a support session) read their own workspace; **no direct writes** from browsers. RPCs: `hanafy_platform_workspace_hardware` (all platform roles), `hanafy_platform_save_hardware_device` (owner/admin, reason, audited), `hanafy_workspace_devices` (business, `hardware.manage`), `hanafy_hardware_heartbeat` (service role only).

## 6. Tests

| Check | Result |
|---|---|
| `tests/hanafy-phase10-hardware-devices.test.ts` (7) | **pass** |
| `hanafy-phase6-platform-admin` (summary/health shapes) | **pass** |
| `tsc --noEmit` | **0 errors** |
| `eslint` on changed paths | **0 problems** |

## 7. Manual test steps

1. `/platform/workspaces/waynes-pizza/hardware` → 7 devices; kitchen printer "Not seen for over a day", router "Not monitored".
2. Add a device (e.g. a tablet) with a reason → appears, and in Audit.
3. `/admin/hardware` → change the receipt printer IP, save → the Platform Hardware tab shows the new IP.

## 8. Known limitations

Router/AP/terminal have no telemetry (by design). A heartbeat HTTP endpoint for the Android app is not exposed yet (the RPC exists; wire it when the app ships).

## Next

Phase 11: Hanafy billing + equipment balances.
