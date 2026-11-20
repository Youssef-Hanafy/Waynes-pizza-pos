-- Expose existing priced category options wherever prepared items lacked them.
-- Reuse the actual configured groups so checkout validates and charges them.
with wanted as (
  select distinct on (item.id,g.customer_label) item.id item_id,item.workspace_id,g.id group_id,
    case when g.customer_label='Vegetables' then 20 when g.customer_label='Meats' then 30 else 50 end sort_order
  from public.menu_items item
  join public.menu_categories category on category.id=item.category_id
  join public.modifier_groups g on g.workspace_id=item.workspace_id
  where item.workspace_id=public.hanafy_legacy_workspace_id()
    and item.customer_visible and item.archived_at is null and not item.special
    and g.active and g.archived_at is null
    and (
      (category.name='Build Your Own Pizza' and item.name='Cheese Pizza' and g.name in ('Build Your Own Pizza – Vegetables','Build Your Own Pizza – Meats'))
      or (category.name='Dinners' and g.name in ('Dinners – Vegetables','Dinners – Meats','Dinners – Cheese'))
      or (category.name='Kids' and item.name='Kid''s Cheeseburger' and g.name in ('Cheeseburger Dinner – Meats','Cheeseburger Dinner – Cheese'))
      or (category.name='Kids' and item.name='Kid''s Pasta' and g.name in ('Pasta – Vegetables','Pasta – Meats','Pasta – Cheese'))
    )
    and exists(select 1 from public.menu_item_modifier_groups source join public.menu_items source_item on source_item.id=source.menu_item_id
      where source.modifier_group_id=g.id and source.active and source_item.customer_visible and source_item.archived_at is null)
    and not exists(select 1 from public.menu_item_modifier_groups existing join public.modifier_groups eg on eg.id=existing.modifier_group_id
      where existing.menu_item_id=item.id and existing.active and eg.active and eg.archived_at is null and eg.customer_label=g.customer_label)
  order by item.id,g.customer_label,g.id
)
insert into public.menu_item_modifier_groups(workspace_id,menu_item_id,modifier_group_id,sort_order,active)
select workspace_id,item_id,group_id,sort_order,true from wanted
on conflict(menu_item_id,modifier_group_id) do update set active=true,sort_order=excluded.sort_order;

-- A shared pizza group uses variant IDs for price overrides. Copy the existing
-- matching-size price to Cheese Pizza's own variant IDs before exposing it.
insert into public.modifier_choice_variant_prices(modifier_choice_id,menu_item_variant_id,price_delta_cents)
select choice.id,target.id,max(vp.price_delta_cents)
from public.menu_items item
join public.menu_item_variants target on target.menu_item_id=item.id and target.active and target.archived_at is null
join public.menu_item_modifier_groups link on link.menu_item_id=item.id and link.active
join public.modifier_groups g on g.id=link.modifier_group_id and g.active and g.archived_at is null
join public.modifier_choices choice on choice.modifier_group_id=g.id and choice.active and choice.archived_at is null
join public.modifier_choice_variant_prices vp on vp.modifier_choice_id=choice.id
join public.menu_item_variants source on source.id=vp.menu_item_variant_id and source.active and source.archived_at is null and lower(source.name)=lower(target.name)
where item.workspace_id=public.hanafy_legacy_workspace_id() and item.name='Cheese Pizza' and item.customer_visible and item.archived_at is null
  and g.name in ('Build Your Own Pizza – Vegetables','Build Your Own Pizza – Meats')
group by choice.id,target.id
on conflict(modifier_choice_id,menu_item_variant_id) do nothing;
