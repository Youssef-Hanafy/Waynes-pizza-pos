-- Nothing has to be picked to add an item (owner, 2026-10-13): "make it so
-- none of the items require sauces to be selected or anything, because if he
-- just wants to quickly select the item on an order".  Cheese Fries come with
-- the cheesy sauce already, so its sauce list was forcing a $2 extra pick.
-- Every option group stays available, it just isn't required.  Admin → Menu
-- can make one required again.
update public.modifier_groups
   set required = false, min_select = 0, updated_at = now()
 where required or min_select > 0;
