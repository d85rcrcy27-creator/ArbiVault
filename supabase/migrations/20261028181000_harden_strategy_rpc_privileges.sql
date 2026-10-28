-- Apply the intended owner-scoped RPC hardening where production migration history drifted.
-- These RPCs are still called by the authenticated app, so keep authenticated EXECUTE but
-- run them as the caller and rely on explicit owner-scoped RLS instead of SECURITY DEFINER.

drop policy if exists strategy_bots_owner_insert on public.arbivault_strategy_bots;
create policy strategy_bots_owner_insert
  on public.arbivault_strategy_bots
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists strategy_bots_owner_delete on public.arbivault_strategy_bots;
create policy strategy_bots_owner_delete
  on public.arbivault_strategy_bots
  for delete to authenticated
  using (owner_id = (select auth.uid()));

alter function public.create_strategy_bot_for_skill(
  text,text,jsonb,jsonb,jsonb,integer,text,jsonb,boolean,boolean
) security invoker;

alter function public.delete_strategy_bot_for_skill(uuid) security invoker;
alter function public.sync_strategy_bot_for_skill(uuid) security invoker;

revoke all on function public.create_strategy_bot_for_skill(
  text,text,jsonb,jsonb,jsonb,integer,text,jsonb,boolean,boolean
) from public, anon;
grant execute on function public.create_strategy_bot_for_skill(
  text,text,jsonb,jsonb,jsonb,integer,text,jsonb,boolean,boolean
) to authenticated;

revoke all on function public.delete_strategy_bot_for_skill(uuid) from public, anon;
grant execute on function public.delete_strategy_bot_for_skill(uuid) to authenticated;

revoke all on function public.sync_strategy_bot_for_skill(uuid) from public, anon;
grant execute on function public.sync_strategy_bot_for_skill(uuid) to authenticated;
