-- RLS checks for agent_tasks. Run against a local Supabase DB after migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/agent_tasks_rls.sql
begin;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'b@example.test');
insert into public.agent_tasks (id, owner_id, title) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'owned by a'),
  ('10000000-0000-0000-0000-000000000002', null, 'shared row');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.agent_tasks) <> 0 then
    raise exception 'user b can read rows it does not own (including shared rows)';
  end if;
  update public.agent_tasks set title = 'hijack' where owner_id is null;
  if found then raise exception 'user b updated a shared row'; end if;
  begin
    insert into public.agent_tasks (owner_id, title) values (null, 'global insert');
    raise exception 'user b inserted a shared row';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.agent_tasks (owner_id, title) values ('00000000-0000-0000-0000-0000000000a1', 'spoof');
    raise exception 'user b inserted a row for another owner';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
