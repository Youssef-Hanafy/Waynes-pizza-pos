-- Fix: saving Admin -> Hardware failed with "The hardware settings could not be
-- saved".  Supabase's API connection runs with safeupdate, which refuses any
-- UPDATE without a WHERE clause, and wayne_update_hardware_settings switched
-- phone lines on/off with a bare "update public.store_phone_lines set ...".
-- (It only worked when called outside the API, e.g. in tests.)  Only the rows
-- that actually change are now updated, with an explicit WHERE.
do $$
declare
  definition text := pg_get_functiondef('public.wayne_update_hardware_settings(jsonb)'::regprocedure);
  old_text text := 'set active = line_number <= (payload ->> ''caller_line_count'')::integer, updated_at = now();';
  new_text text := 'set active = line_number <= (payload ->> ''caller_line_count'')::integer, updated_at = now()
     where active is distinct from (line_number <= (payload ->> ''caller_line_count'')::integer);';
begin
  if (length(definition) - length(replace(definition, old_text, ''))) / length(old_text) <> 1 then
    raise exception 'wayne_update_hardware_settings: expected exactly one bare phone-line update';
  end if;
  execute replace(definition, old_text, new_text);
end $$;
