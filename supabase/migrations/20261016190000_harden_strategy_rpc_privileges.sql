-- Harden strategy RPCs by using invoker privileges and explicit owner-scoped RLS.
-- The RPC bodies already constrain every row operation by auth.uid().
-- Policies are added before switching off SECURITY DEFINER so normal owner
-- workflows remain available without elevated function privileges.

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
