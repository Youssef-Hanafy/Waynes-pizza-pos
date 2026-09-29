# Hanafy Media CRM — SQL applied from this repo

The CRM's source isn't in this repo, but some Wayne's ↔ CRM fixes are pure
database changes on the CRM's Supabase project (`lgbdfqpnlvjxdlalhnbk`).
They're kept here so they are versioned somewhere. Each file was applied to
the live CRM project with the Supabase connector on the date in its name.

| File | What it does |
| --- | --- |
| `20260923_waynes_order_mirror_and_text_club_list.sql` | Mirrors Wayne's order events into `crm_orders` (so contacts get order count, lifetime value, last order) and keeps the "Waynes Pizza Text Club" list in step with SMS consent. |
| `20260923_winback_automation_draft.sql` | Adds the **30-day win-back** automation as a *draft* (publish it in /admin/sms → Automations after checking the wording). |
