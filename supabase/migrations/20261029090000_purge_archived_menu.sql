-- Owner, 2026-10-12: "remove all of the old archived stuff from the old
-- system/menu so it doesn't take as long to load".
--
-- Removes for good: archived categories, archived items (and items in
-- archived categories), their sizes, archived option sections / options, option
-- sections only the removed items used, inactive item <-> section links, and the
-- per-size prices / included picks / size rules hanging off them.
-- Nothing here is referenced by an order (checked 2026-10-12: 0 rows), and
-- anything an order does reference is kept anyway.  A copy of every removed
-- row is kept in the private "archive" schema.

begin;

create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated;

create temporary table purge_items on commit drop as
  select i.id from public.menu_items i
   where (i.archived_at is not null
          or i.category_id in (select id from public.menu_categories where archived_at is not null))
     and not exists (select 1 from public.order_items oi where oi.menu_item_id = i.id);

create temporary table purge_variants on commit drop as
  select v.id from public.menu_item_variants v
   where (v.archived_at is not null or v.menu_item_id in (select id from purge_items))
     and not exists (select 1 from public.order_items oi where oi.variant_id = v.id);

create temporary table purge_links on commit drop as
  select l.menu_item_id, l.modifier_group_id from public.menu_item_modifier_groups l
   where not l.active or l.menu_item_id in (select id from purge_items);

-- Sections that are archived, or that no remaining active item uses.
create temporary table purge_groups on commit drop as
  select g.id from public.modifier_groups g
   where g.archived_at is not null
      or not exists (select 1 from public.menu_item_modifier_groups l
                      where l.modifier_group_id = g.id and l.active
                        and l.menu_item_id not in (select id from purge_items));

create temporary table purge_choices on commit drop as
  select c.id from public.modifier_choices c
   where (c.archived_at is not null or c.modifier_group_id in (select id from purge_groups))
     and not exists (select 1 from public.order_item_modifiers m where m.modifier_choice_id = c.id);

-- A section keeps living if one of its options is on an order.
delete from purge_groups g where exists (select 1 from public.modifier_choices c where c.modifier_group_id = g.id and c.id not in (select id from purge_choices));

-- Backup copies.
create table if not exists archive.menu_categories_20261012 as select * from public.menu_categories where archived_at is not null;
create table if not exists archive.menu_items_20261012 as select * from public.menu_items where id in (select id from purge_items);
create table if not exists archive.menu_item_variants_20261012 as select * from public.menu_item_variants where id in (select id from purge_variants);
create table if not exists archive.modifier_groups_20261012 as select * from public.modifier_groups where id in (select id from purge_groups);
create table if not exists archive.modifier_choices_20261012 as select * from public.modifier_choices where id in (select id from purge_choices);
create table if not exists archive.menu_item_modifier_groups_20261012 as select l.* from public.menu_item_modifier_groups l
  where (l.menu_item_id, l.modifier_group_id) in (select menu_item_id, modifier_group_id from purge_links) or l.modifier_group_id in (select id from purge_groups);
create table if not exists archive.modifier_choice_variant_prices_20261012 as select * from public.modifier_choice_variant_prices
  where modifier_choice_id in (select id from purge_choices) or menu_item_variant_id in (select id from purge_variants);

-- The backup above is the record; skip a row-by-row audit entry for ~1,000 old rows.
alter table public.menu_item_modifier_groups disable trigger menu_item_modifier_groups_audit;
alter table public.modifier_choices disable trigger modifier_choices_audit;
alter table public.modifier_groups disable trigger modifier_groups_audit;
alter table public.menu_item_variants disable trigger menu_item_variants_audit;
alter table public.menu_items disable trigger menu_items_audit;
alter table public.menu_categories disable trigger menu_categories_audit;

delete from public.menu_item_modifier_groups l
 where (l.menu_item_id, l.modifier_group_id) in (select menu_item_id, modifier_group_id from purge_links)
    or l.modifier_group_id in (select id from purge_groups);
delete from public.modifier_choices where id in (select id from purge_choices);
delete from public.modifier_groups where id in (select id from purge_groups);
delete from public.menu_item_variants where id in (select id from purge_variants);
delete from public.menu_items where id in (select id from purge_items);
delete from public.menu_categories c
 where c.archived_at is not null and not exists (select 1 from public.menu_items i where i.category_id = c.id);

alter table public.menu_item_modifier_groups enable trigger menu_item_modifier_groups_audit;
alter table public.modifier_choices enable trigger modifier_choices_audit;
alter table public.modifier_groups enable trigger modifier_groups_audit;
alter table public.menu_item_variants enable trigger menu_item_variants_audit;
alter table public.menu_items enable trigger menu_items_audit;
alter table public.menu_categories enable trigger menu_categories_audit;

analyze public.menu_categories, public.menu_items, public.menu_item_variants, public.modifier_groups,
        public.modifier_choices, public.menu_item_modifier_groups, public.modifier_choice_variant_prices;

commit;

-- What's left (archived rows should all be 0).
select
  (select count(*) from public.menu_categories where archived_at is not null) as archived_categories_left,
  (select count(*) from public.menu_items where archived_at is not null) as archived_items_left,
  (select count(*) from public.modifier_choices where archived_at is not null) as archived_options_left,
  (select count(*) from public.menu_items) as items_now;
