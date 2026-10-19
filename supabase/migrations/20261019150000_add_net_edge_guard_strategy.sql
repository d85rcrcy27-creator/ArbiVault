-- Net Edge Guard: a cost-aware, discovery-first strategy with an explicit skill link.
-- Safe to re-run; execution and transaction builders remain disabled pending verification.

with owner as (
  select owner_id
  from public.arbivault_strategy_bots
  where owner_id is not null
  order by created_at
  limit 1
)
insert into public.arbivault_strategy_bots
(name,strategy,priority,enabled,execution_enabled,flash_loan_enabled,chains,max_trade_size,min_profit_threshold,slippage_tolerance,max_gas_budget,cooldown_ms,owner_id,wallet_policy,wallet_state)
select 'Net Edge Guard — Cost-Aware Arbitrage','net_edge_guard','early_bird',true,false,false,
       array['ethereum','bnb','solana']::text[],100,2,0.35,5,1000,owner.owner_id,
       'dedicated_per_chain','wallet_required'
from owner
on conflict (name) do update set
  strategy=excluded.strategy, enabled=true, execution_enabled=false, flash_loan_enabled=false,
  chains=excluded.chains, max_trade_size=excluded.max_trade_size,
  min_profit_threshold=excluded.min_profit_threshold, slippage_tolerance=excluded.slippage_tolerance,
  max_gas_budget=excluded.max_gas_budget, cooldown_ms=excluded.cooldown_ms, updated_at=now();

insert into public.bot_skills
(owner_id,name,description,active,conditions,actions,risk_limits,cooldown_seconds,strategy_family,data_sources,observation_only,discovery_enabled,strategy_bot_id)
select b.owner_id,
 'Net Edge Guard — Live Cost Filter',
 'Evaluates recorded live market observations against spread, net-profit-after-costs, quote freshness, liquidity and executable-route gates. Discovery/backtest only until execution is explicitly validated.',
 true,
 '[{"type":"condition","label":"IF executable spread >=", "value":"0.30","unit":"%"},{"type":"condition","label":"IF net profit after all costs >=", "value":"2.00","unit":"USD"},{"type":"condition","label":"IF quote age <=", "value":"1000","unit":"ms"},{"type":"condition","label":"IF both execution legs verified","value":"true","unit":"boolean"},{"type":"condition","label":"IF liquidity depth verified","value":"true","unit":"boolean"}]'::jsonb,
 '[{"type":"action","label":"THEN evaluate recorded live observation"},{"type":"action","label":"THEN reject if fee, slippage, gas or route data missing"},{"type":"action","label":"THEN record candidate or rejection reason"},{"type":"action","label":"THEN require separate execution authorization"}]'::jsonb,
 '{"maxNotional":100,"max_trade_size":100,"min_profit_threshold":2,"max_slippage_bps":35,"max_quote_age_ms":1000,"max_gas_budget":5,"require_net_profit_after_costs":true,"require_live_quote":true,"require_both_legs_executable":true,"require_liquidity_depth":true}'::jsonb,
 1,'exchange_arbitrage',
 '["public_exchange_order_books","live_dex_quotes","fee_estimates","gas_estimates","execution_latency"]'::jsonb,
 true,true,b.id
from public.arbivault_strategy_bots b
where b.name='Net Edge Guard — Cost-Aware Arbitrage'
and not exists (
 select 1 from public.bot_skills s
 where s.strategy_bot_id=b.id and s.name='Net Edge Guard — Live Cost Filter'
);

insert into public.arbivault_strategy_routes
(strategy,strategy_family,chain,pair,dex_venue,reference_venue,route_type,enabled,discovery_only,strategy_bot_id,transaction_builder,builder_enabled,builder_status)
select v.strategy,v.strategy_family,v.chain,v.pair,v.dex_venue,v.reference_venue,v.route_type,true,true,b.id,v.transaction_builder,false,'cost_gate_validation_required'
from public.arbivault_strategy_bots b
cross join (values
 ('net_edge_guard','exchange_arbitrage','ethereum','ETH/USDC','Uniswap','CEX','dex_cex','uniswap_v2'),
 ('net_edge_guard','exchange_arbitrage','bnb','BNB/USDT','PancakeSwap','CEX','dex_cex','pancakeswap_v2'),
 ('net_edge_guard','exchange_arbitrage','solana','SOL/USDC','Jupiter','CEX','dex_cex','jupiter_swap_v2')
) as v(strategy,strategy_family,chain,pair,dex_venue,reference_venue,route_type,transaction_builder)
where b.name='Net Edge Guard — Cost-Aware Arbitrage'
on conflict (strategy,chain,pair,dex_venue,reference_venue) do update set
 enabled=true,discovery_only=true,strategy_bot_id=excluded.strategy_bot_id,
 transaction_builder=excluded.transaction_builder,builder_enabled=false,
 builder_status='cost_gate_validation_required',updated_at=now();
