-- Workspace permission alone must not expose another employee's ledger.
drop policy if exists hanafy_workspace_read on public.delivery_assignments;
create policy hanafy_workspace_read on public.delivery_assignments for select to authenticated using (
  public.wayne_has_permission(workspace_id,'delivery.dispatch')
  or public.wayne_has_permission(workspace_id,'reports.view')
  or (driver_id=auth.uid() and public.wayne_has_permission(workspace_id,'driver.access'))
);
drop policy if exists hanafy_workspace_read on public.register_shifts;
create policy hanafy_workspace_read on public.register_shifts for select to authenticated using (
  public.wayne_has_permission(workspace_id,'cash.manage')
  or (opened_by_user_id=auth.uid() and public.wayne_has_permission(workspace_id,'pos.access'))
);

-- Provider event payloads have always been a server-only ledger. The generic
-- workspace policy accidentally exposed them to payment managers.
drop policy if exists hanafy_workspace_read on public.payment_webhook_events;
