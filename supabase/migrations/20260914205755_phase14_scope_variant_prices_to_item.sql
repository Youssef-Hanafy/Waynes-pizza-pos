-- Option groups are shared between the items that share them, so a choice's
-- per-size prices covered every item using that group: a Small pizza's feed
-- carried the sizes of every other pizza too. Harmless when pricing (the cart
-- looks a size up by id) but it inflated the customer menu payload to 2.3 MB,
-- which every customer downloads to open the ordering page.
--
-- Scope each choice's variant_prices to the item being rendered. 2.3 MB -> 1.2 MB.
do $$
declare definition text;
begin
  for definition in
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('wayne_public_menu', 'wayne_pos_menu')
  loop
    definition := replace(
      definition,
      'where vp.modifier_choice_id = choice.id',
      'where vp.modifier_choice_id = choice.id
                            and exists (
                              select 1 from public.menu_item_variants scoped
                              where scoped.id = vp.menu_item_variant_id
                                and scoped.menu_item_id = item.id
                            )'
    );
    execute definition;
  end loop;
end $$;
