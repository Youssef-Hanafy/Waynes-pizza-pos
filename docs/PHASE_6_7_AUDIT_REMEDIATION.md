# Phase 6–7 audit remediation and acceptance record

Apply `20260911080000_phase6_7_audit_remediation.sql` after the existing Phase 6 and 7 migrations. It is forward-only and is safe for an environment that already has those phases deployed.

## What changed

- Reports now include sales and order trend charts. The daily data table remains the accessible, detailed representation.
- The orders CSV uses `wayne_report_orders`, the same business-date and non-cancelled eligibility as report totals.
- Accounting policy is explicit: cancelled orders and their refunds are excluded; otherwise a refund reduces net sales on the New York business date it was issued.
- Disabling a segment closes every active membership once; re-enabling can create a new membership and one new enter event.
- Refund insert, update, and delete rebuild the relevant customer metrics and therefore re-evaluate spend-based segments.
- The metric rebuilder and scheduler-only evaluator are no longer callable by an authenticated browser client. Order/refund triggers and the scheduled database job retain access.
- A `customer_segment_evaluation_runs` log records nightly evaluator successes and failures.

## Scheduler

Where `pg_cron` is enabled, the migration creates `waynes-nightly-inactivity-evaluator` at 05:05 UTC. This is midnight in New York during standard time and 01:05 during daylight time; the evaluator uses its execution time and does not depend on a fixed UTC offset for membership calculations. Confirm the job after deploy:

```sql
select jobid, jobname, schedule, command from cron.job where jobname = 'waynes-nightly-inactivity-evaluator';
select status, started_at, completed_at, customers_evaluated, error_message
from public.customer_segment_evaluation_runs order by started_at desc limit 20;
```

If the project has not enabled `pg_cron`, enable it in Supabase Database Extensions and re-run only the scheduler `DO` block from the remediation migration. Alert on any `failed` run or any run that remains `running` for more than 30 minutes.

## Live acceptance record

Record this evidence in the staging handoff after deployment:

| Check | Record |
| --- | --- |
| Phase 6 reconciliation | Operator, report range, exported order count/total, dashboard count/net total, result |
| Timezone boundary | Order/refund IDs immediately before and after a New York midnight, expected/actual business dates |
| Refund accounting | Eligible later-period refund and subsequently cancelled refunded-order IDs, expected/actual totals |
| Phase 7 customer metrics | Customer ID, qualifying orders/refunds, expected/actual count, spend, AOV |
| Segment transitions | Rule change or enablement action, exact enter/exit event IDs and timestamps |
| Restricted role | Cashier identity and denied customer/rebuilder endpoint/RPC result |
| Scheduler | `cron.job` row, a successful run-log row, and alert-path test result |
