-- Complete the realtime publication for every source the Mad Man Revenue Stream subscribes to.
-- Guard table existence so this migration remains safe across staged schema rollouts.
do $$
declare
  target_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'required_publication_supabase_realtime_missing';
  end if;

  foreach target_table in array array[
    'payments',
    'tasks',
    'opportunities',
    'trades',
    'bot_execution_runs'
  ]
  loop
    if to_regclass('public.' || quote_ident(target_table)) is not null
       and not exists (
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
