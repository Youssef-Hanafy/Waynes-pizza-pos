-- Salads: Extra Bread button (owner, 2026-10-12).
-- Added to the salad "Extras" section next to Croutons at $1.65 (the printed
-- take-out menu's salad-extras price for bread); editable in Admin -> Menu ->
-- Salads -> Options.  The section now allows more than one pick (croutons AND
-- bread) and quantities (2 extra breads).
do $$
declare extras uuid; ws uuid;
begin
  select id, workspace_id into extras, ws from public.modifier_groups
   where name = 'Salads – Extras' and archived_at is null limit 1;
  if extras is null then raise notice 'Salads – Extras not found; skipping'; return; end if;

  update public.modifier_groups
     set allow_quantities = true, max_select = greatest(max_select, 10), updated_at = now()
   where id = extras;

  if not exists (select 1 from public.modifier_choices
                  where modifier_group_id = extras and name = 'Extra Bread' and archived_at is null) then
    insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, default_selected, sort_order, active, workspace_id)
    values (extras, 'Extra Bread', 165, false,
            coalesce((select max(sort_order) + 10 from public.modifier_choices where modifier_group_id = extras), 10), true, ws);
  end if;
end $$;
