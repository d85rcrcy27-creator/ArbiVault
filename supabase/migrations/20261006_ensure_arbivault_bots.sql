-- ensure_arbivault_bots: idempotent bot-fleet bootstrap for the restored UI.
-- The client calls rpc('ensure_arbivault_bots') with no parameters; this
-- migration creates the zero-argument function, adds the bot_role/last_error
-- columns the restored UI expects, and reloads the PostgREST schema cache.

-- 1. Guarantee the table exists (no-op when the entities migration already ran).
create table if not exists public.bot_configs (
  id uuid primary key default gen_random_uuid(),
  created_by_id uuid not null references auth.users(id) on delete cascade,
  chain text not null check (chain in ('solana','bnb','bitcoin')),
  strategy text not null check (strategy in ('flash_loan','flash_swap','mempool_sandwich','liquidity_fragmentation','cross_chain_latency','global')),
  enabled boolean not null default false,
  min_profit_threshold numeric not null default 0.5, max_gas_budget numeric not null default 0.01,
  slippage_tolerance numeric not null default 1.0, max_trade_size numeric not null default 10000,
  opportunities_detected numeric not null default 0, opportunities_executed numeric not null default 0,
  opportunities_skipped numeric not null default 0, last_scan timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- 2. Upgrade pre-existing tables to the restored role-based bot model.
alter table public.bot_configs add column if not exists bot_role text not null default 'execution'
  check (bot_role in ('execution','sync','payment'));
alter table public.bot_configs add column if not exists last_error text;
create index if not exists bot_configs_owner_role_idx on public.bot_configs(created_by_id, bot_role);

-- 3. Owner access for the client update path (additive; unions with any
--    existing owner-or-admin policies).
alter table public.bot_configs enable row level security;
grant select, insert, update, delete on public.bot_configs to authenticated;
drop policy if exists bot_configs_owner_all on public.bot_configs;
create policy bot_configs_owner_all on public.bot_configs
  for all to authenticated
  using ((select auth.uid()) = created_by_id)
  with check ((select auth.uid()) = created_by_id);

-- 4. The zero-parameter RPC. Inserts any missing role bot for the caller and
--    returns the caller's fleet. security definer keeps it working regardless
--    of which policy set the project carries.
create or replace function public.ensure_arbivault_bots()
returns setof public.bot_configs
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required';
  end if;

  insert into public.bot_configs (created_by_id, chain, strategy, bot_role, enabled)
  select caller, 'bnb', 'global', role, true
  from (values ('execution'), ('sync'), ('payment')) as roles(role)
  where not exists (
    select 1 from public.bot_configs b
    where b.created_by_id = caller and b.bot_role = roles.role
  );

  return query
  select * from public.bot_configs
  where created_by_id = caller
  order by bot_role;
end;
$$;

revoke all on function public.ensure_arbivault_bots() from public, anon;
grant execute on function public.ensure_arbivault_bots() to authenticated;

-- 5. Refresh PostgREST's schema cache so the function is callable immediately
--    (fixes "not found in the schema cache" without a project restart).
notify pgrst, 'reload schema';
