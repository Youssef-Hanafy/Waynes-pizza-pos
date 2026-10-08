-- ROOT CAUSE of "Hardware settings don't save / go back to defaults" and
-- "the Stripe M2 never shows on the POS" (2026-10-08).
--
-- location_hardware_configurations and location_payment_configurations have
-- row-level-security read policies for workspace members, but the
-- `authenticated` role was never GRANTed SELECT on the tables themselves
-- (the phase 0-8 remediation revoked default table privileges).  Every read
-- from a signed-in staff session therefore failed with "permission denied":
--   * Admin -> Hardware fell back to its safe defaults after every save, even
--     though the save (a SECURITY DEFINER function) had been written;
--   * the POS was handed the defaults (payment_terminal_mode =
--     manual_external), so the Card reader panel never appeared and payments
--     never went to the M2;
--   * the Stripe Terminal routes refused with "card reader is switched off".
--
-- Grant read access only; RLS (location_hardware_member_read,
-- location_payment_member_read) still limits rows to the member's own
-- workspace, and writes still go through the hanafy_save_* functions.

grant select on public.location_hardware_configurations to authenticated;
grant select on public.location_payment_configurations to authenticated;
