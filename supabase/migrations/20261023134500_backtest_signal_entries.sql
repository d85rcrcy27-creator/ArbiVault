create or replace function public.arbivault_backtest_signal_entries(
  p_owner_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_min_spread_pct numeric
)
returns table (
  id uuid,
  symbol text,
  metric text,
  value numeric,
  observed_at timestamptz,
  metadata jsonb,
  previous_value numeric,
  volume24h_usd numeric
)
language sql
stable
security invoker
set search_path = public
as $function$
  with ordered_observations as materialized (
    select
      o.id,
      o.symbol,
      o.metric,
      o.value,
      o.observed_at,
      o.metadata,
      lag(o.value) over (
        partition by
          o.symbol,
          coalesce(o.metadata->>'buy_exchange', o.metadata->>'buyExchange', ''),
          coalesce(o.metadata->>'sell_exchange', o.metadata->>'sellExchange', '')
        order by o.observed_at, o.id
      ) as previous_value
    from public.strategy_observations o
    where o.owner_id = p_owner_id
      and o.source_key = 'public_exchange_order_books'
      and o.domain = 'execution_scout'
      and o.metric = 'spread_pct'
      and o.observed_at >= p_start_at
      and o.observed_at <= p_end_at
  ),
  candidate_observations as (
    select o.*
    from ordered_observations o
    where o.value >= p_min_spread_pct
  )
  select
    e.id,
    e.symbol,
    e.metric,
    e.value,
    e.observed_at,
    e.metadata,
    e.previous_value,
    volume.volume24h_usd
  from candidate_observations e
  left join lateral (
    select
      case
        when v.metadata->>'volume24h' ~ '^[0-9]+([.][0-9]+)?$'
          then (v.metadata->>'volume24h')::numeric
        else null
      end as volume24h_usd
    from public.strategy_observations v
    where v.owner_id = p_owner_id
      and v.source_key = 'coingecko'
      and v.metric = 'public_market_price'
      and v.symbol = split_part(e.symbol, '/', 1) || '/USD'
      and v.observed_at >= e.observed_at - interval '10 minutes'
      and v.observed_at <= e.observed_at + interval '10 minutes'
    order by abs(extract(epoch from (v.observed_at - e.observed_at))), v.observed_at
    limit 1
  ) volume on true
  order by e.observed_at, e.id;
$function$;

revoke all on function public.arbivault_backtest_signal_entries(uuid,timestamptz,timestamptz,numeric) from public, anon, authenticated;
grant execute on function public.arbivault_backtest_signal_entries(uuid,timestamptz,timestamptz,numeric) to service_role;
