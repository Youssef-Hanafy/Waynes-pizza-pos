-- Extra portions of sauces (owner, 2026-09-22): a customer can ask for more of
-- a sauce the item already comes with ("extra marinara"), not only add a
-- different sauce.  Turning quantities on for a group is all the order screens
-- and server pricing need: the portion the item comes with stays free and each
-- extra portion is charged at the sauce's price.
--
-- Left as they are on purpose:
--   * Pasta – Sauces: marinara comes with the pasta at $0, and the menu already
--     has its own paid "extra sauce" ($1.75) option. Doubling marinara there
--     would give extra sauce away free.
--   * Salad Dressing (the dressing the salad comes with, $0): extra dressing is
--     the separate paid "Salads – Salad Dressings" group, which gets quantities.
-- "No Sauce" / "Light Sauce" stay one-per-item in the screens.
update public.modifier_groups
set allow_quantities = true, updated_at = now()
where active and archived_at is null and not allow_quantities and max_select > 1
  and ((name like '% – Sauces' and name <> 'Pasta – Sauces') or name = 'Salads – Salad Dressings');
