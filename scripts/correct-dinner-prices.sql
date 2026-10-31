-- REVIEW / APPROVAL REQUIRED before running against production.
-- Apply the menu_price_editing migration first. This transaction updates only
-- the two existing, regular, active dinner rows; it never creates menu records.
begin;
do $$
declare target record; target_ids uuid[] := '{}'; item_name text;
begin
  -- Block concurrent item/variant imports while validating identity and price.
  lock table public.menu_items, public.menu_categories, public.menu_item_variants in share row exclusive mode;
  foreach item_name in array array['Cheeseburger Dinner','Gyro Dinner'] loop
    if (select count(*) from public.menu_items i join public.menu_categories c on c.id=i.category_id
        join public.workspaces w on w.id=i.workspace_id
        where w.slug='waynes-pizza' and c.workspace_id=w.id and c.name='Dinners' and c.archived_at is null
          and i.name=item_name and i.archived_at is null and not i.special) <> 1 then
      raise exception 'Expected exactly one active regular Dinners record for %; inspect duplicates/missing records',item_name;
    end if;
    select i.* into target from public.menu_items i join public.menu_categories c on c.id=i.category_id
      join public.workspaces w on w.id=i.workspace_id where w.slug='waynes-pizza' and c.workspace_id=w.id
      and c.name='Dinners' and c.archived_at is null and i.name=item_name and i.archived_at is null and not i.special;
    if not found then raise exception 'Record changed during verification for %',item_name; end if;
    if target.id <> (case item_name when 'Cheeseburger Dinner' then '418c30cc-344c-4200-917d-0d60c183c77c'::uuid else '5677ccf0-ba1d-41a1-8382-473233f61ea9'::uuid end)
       or target.workspace_id <> '40000000-0000-4000-8000-000000000001'::uuid
       or target.category_id <> '3fcd712d-f81a-45cf-9251-228af6584bdc'::uuid then
      raise exception 'Record identity changed for %; review before applying',item_name;
    end if;
    if target.base_price_cents not in (1350,1425) then raise exception 'Unexpected price for %: % cents',item_name,target.base_price_cents; end if;
    if exists(select 1 from public.menu_item_variants where menu_item_id=target.id and active and archived_at is null) then
      raise exception 'Unexpected size price override for %; inspect before applying',item_name;
    end if;
    target_ids := array_append(target_ids,target.id);
    raise notice 'Verified %: menu_items.id=%, base_price_cents=% -> 1425, workspace_id=%',item_name,target.id,target.base_price_cents,target.workspace_id;
  end loop;
  update public.menu_items set base_price_cents=1425 where id=any(target_ids) and base_price_cents<>1425;
end;
$$;
select id,workspace_id,category_id,name,base_price_cents,menu_revision from public.menu_items
where id in (select i.id from public.menu_items i join public.menu_categories c on c.id=i.category_id
join public.workspaces w on w.id=i.workspace_id where w.slug='waynes-pizza' and c.name='Dinners'
and c.archived_at is null and i.archived_at is null and not i.special and i.name in ('Cheeseburger Dinner','Gyro Dinner'));
commit;
