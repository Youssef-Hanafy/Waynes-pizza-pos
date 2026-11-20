-- Repair imported zero prices using existing prices for the same ingredient.
-- Included portions remain governed by recipe and size allowances.
with prices as (
  select g.workspace_id, c.name, mode() within group (order by c.price_delta_cents) price
  from public.modifier_choices c join public.modifier_groups g on g.id=c.modifier_group_id
  where c.active and c.archived_at is null and g.active and g.archived_at is null
    and g.workspace_id=public.hanafy_legacy_workspace_id()
    and g.name ~ ' – (Meats|Cheese)$' and c.price_delta_cents>0
  group by g.workspace_id,c.name
)
update public.modifier_choices c set price_delta_cents=p.price,updated_at=now()
from public.modifier_groups g,prices p
where c.modifier_group_id=g.id and g.workspace_id=p.workspace_id and c.name=p.name
  and c.active and c.archived_at is null and g.active and g.archived_at is null
  and g.name ~ ' – (Meats|Cheese)$' and c.price_delta_cents=0;

-- The special includes two toppings. Extra meat is already available in the
-- separately priced Meats group; the imported duplicate must not bypass it.
update public.modifier_groups set max_select=2,allow_quantities=false,updated_at=now()
where workspace_id=public.hanafy_legacy_workspace_id() and name='Pasta Special – Toppings' and active and archived_at is null;
update public.modifier_choices c set active=false,updated_at=now()
from public.modifier_groups g
where c.modifier_group_id=g.id and g.workspace_id=public.hanafy_legacy_workspace_id()
  and g.name='Pasta Special – Toppings' and c.name='Extra Meat' and c.price_delta_cents=0;

-- Pick-N pizza allowances already make the first N portions free. Give the
-- remaining imported zero-priced vegetables the existing pizza vegetable rate.
with prices as (
  select g.workspace_id,c.name,mode() within group(order by c.price_delta_cents) price
  from public.modifier_choices c join public.modifier_groups g on g.id=c.modifier_group_id
  where g.workspace_id=public.hanafy_legacy_workspace_id() and g.name like '%Pizza – Vegetables'
    and g.active and g.archived_at is null and c.active and c.archived_at is null and c.price_delta_cents>0
  group by g.workspace_id,c.name
), fallback as (
  select workspace_id,mode() within group(order by price) price from prices group by workspace_id
)
update public.modifier_choices c set price_delta_cents=coalesce((select p.price from prices p where p.workspace_id=g.workspace_id and p.name=c.name),f.price),updated_at=now()
from public.modifier_groups g join fallback f on f.workspace_id=g.workspace_id
where c.modifier_group_id=g.id
  and g.name ~ '^(One|Two|Three) Topping Pizza – Toppings?$'
  and c.name in ('Cucumbers','Grilled Mushrooms','Hot Pepper','Veggies')
  and c.price_delta_cents=0 and c.active and c.archived_at is null;
