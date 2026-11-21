-- Owner: the One Size Buffalo egg roll comes with one free sauce, just like
-- Steak Egg Roll. Only correct the verified existing two-portion rule.
update public.modifier_group_size_rules r set included_count=1
from public.menu_item_modifier_groups l join public.menu_items i on i.id=l.menu_item_id
join public.modifier_groups g on g.id=l.modifier_group_id
where r.modifier_group_id=g.id and l.active and i.archived_at is null
  and i.id='4a6f4ae9-ba1d-4bda-b992-56df0b9af651'::uuid
  and i.workspace_id='40000000-0000-4000-8000-000000000001'::uuid
  and i.name='Buffalo Chicken Egg Roll' and g.customer_label='Sauces'
  and lower(btrim(r.size_name))='one size' and r.included_count=2
  and not exists(select 1 from public.menu_item_modifier_groups other
    where other.modifier_group_id=g.id and other.active and other.menu_item_id<>i.id);
