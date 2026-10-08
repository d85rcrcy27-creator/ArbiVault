-- Strategy-bot creation is atomic and owned by the authenticated user.
-- The function creates the strategy bot and linked bot skill in one transaction.
create or replace function public.create_strategy_bot_for_skill(
  p_name text,
  p_description text default '',
  p_conditions jsonb default '[]'::jsonb,
  p_actions jsonb default '[]'::jsonb,
  p_risk_limits jsonb default '{}'::jsonb,
  p_cooldown_seconds integer default 30,
  p_strategy_family text default null,
  p_data_sources jsonb default '[]'::jsonb,
  p_observation_only boolean default true,
  p_discovery_enabled boolean default false
)
returns public.bot_skills
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  bot_id uuid;
  skill_row public.bot_skills;
  base_bot_name text := trim(p_name) || ' — Bot';
  bot_name text := base_bot_name;
  strategy_key text;
  suffix integer := 1;
begin
  if uid is null then raise exception 'authentication required'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'strategy name required'; end if;

  while exists (select 1 from public.arbivault_strategy_bots where name = bot_name) loop
    suffix := suffix + 1;
    bot_name := base_bot_name || ' #' || suffix::text;
  end loop;

  strategy_key := coalesce(
    nullif(trim(p_strategy_family),''),
    nullif(regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '_', 'g'), ''),
    'custom_strategy'
  );

  insert into public.arbivault_strategy_bots(
    owner_id, name, strategy, priority, enabled, execution_enabled,
    flash_loan_enabled, chains, max_trade_size, min_profit_threshold,
    slippage_tolerance, max_gas_budget, cooldown_ms,
    wallet_policy, wallet_state
  )
  values (
    uid, bot_name, strategy_key, 'early_bird', true, not p_observation_only,
    false, array[]::text[], null, null, null, null, greatest(0, coalesce(p_cooldown_seconds,30))*1000,
    'dedicated_per_chain', 'wallet_required'
  )
  returning id into bot_id;

  insert into public.bot_skills(
    owner_id, bot_config_id, name, description, conditions, actions, risk_limits,
    cooldown_seconds, strategy_family, data_sources, observation_only,
    discovery_enabled, strategy_bot_id
  )
  values (
    uid, null, trim(p_name), coalesce(p_description,''), coalesce(p_conditions,'[]'::jsonb),
    coalesce(p_actions,'[]'::jsonb), coalesce(p_risk_limits,'{}'::jsonb),
    greatest(0, coalesce(p_cooldown_seconds,30)), p_strategy_family,
    coalesce(p_data_sources,'[]'::jsonb), p_observation_only, p_discovery_enabled, bot_id
  )
  returning * into skill_row;

  return skill_row;
end;
$$;

revoke all on function public.create_strategy_bot_for_skill(text,text,jsonb,jsonb,jsonb,integer,text,jsonb,boolean,boolean) from public;
grant execute on function public.create_strategy_bot_for_skill(text,text,jsonb,jsonb,jsonb,integer,text,jsonb,boolean,boolean) to authenticated;
