create or replace function public.sample_arbivault_market_observations(
  p_owner_id uuid,
  p_source_key text,
  p_domain text,
  p_metric text,
  p_symbols text[],
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_sample_limit integer
)
returns table (
  id uuid,
  symbol text,
  metric text,
  value numeric,
  observed_at timestamptz,
  metadata jsonb,
  available_count bigint
)
language sql
stable
security invoker
set search_path = public
as $function$
  with filtered as materialized (
    select
      o.id,
      o.symbol,
      o.metric,
      o.value,
      o.observed_at,
      o.metadata,
      ntile(greatest(1, least(coalesce(p_sample_limit, 10000), 10000)))
        over (order by o.observed_at, o.id) as sample_bucket,
      count(*) over () as available_count
    from public.strategy_observations o
    where o.owner_id = p_owner_id
      and o.source_key = p_source_key
      and (p_domain is null or o.domain = p_domain)
      and o.metric = p_metric
      and o.observed_at >= p_start_at
      and o.observed_at <= p_end_at
      and (coalesce(cardinality(p_symbols), 0) = 0 or o.symbol = any(p_symbols))
  ),
  ranked as (
    select
      f.*,
      row_number() over (partition by f.sample_bucket order by f.observed_at, f.id) as bucket_row
    from filtered f
  )
  select
    r.id, r.symbol, r.metric, r.value, r.observed_at, r.metadata, r.available_count
  from ranked r
  where r.bucket_row = 1
  order by r.observed_at, r.id;
$function$;

revoke all on function public.sample_arbivault_market_observations(uuid,text,text,text,text[],timestamptz,timestamptz,integer) from public, anon, authenticated;
grant execute on function public.sample_arbivault_market_observations(uuid,text,text,text,text[],timestamptz,timestamptz,integer) to service_role;
