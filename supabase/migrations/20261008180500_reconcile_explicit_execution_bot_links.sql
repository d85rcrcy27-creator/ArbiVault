-- Reconcile explicit executable routes with their linked strategy bots.
-- Research/discovery routes remain untouched.
update public.arbivault_strategy_bots b
set execution_enabled=true,
    updated_at=now()
where b.id in (
  select distinct r.strategy_bot_id
  from public.arbivault_strategy_routes r
  where r.enabled=true
    and r.discovery_only=false
    and r.builder_enabled=true
    and r.transaction_builder is not null
    and r.strategy_bot_id is not null
);
