-- Keep the paid-work source tables in Supabase Realtime so the Mad Man
-- Revenue Stream can react to task, opportunity, and payment changes.
do $$
declare
  target_table text;
begin
  foreach target_table in array array['payments', 'tasks', 'opportunities']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = target_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target_table);
    end if;
  end loop;
end $$;
