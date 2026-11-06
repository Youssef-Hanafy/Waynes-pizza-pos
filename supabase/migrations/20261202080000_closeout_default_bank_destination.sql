-- Standard Stripe accounts do not always expose Connect's external-bank list.
-- Omitting destination in the Payouts API sends USD to the existing default
-- external account. No bank information is added or changed by the POS.
alter table public.closeout_payout_control drop constraint closeout_payout_control_bank_id_check;
alter table public.closeout_payout_control add constraint closeout_payout_control_bank_id_check
  check (bank_id = 'default' or bank_id like 'ba_%');
