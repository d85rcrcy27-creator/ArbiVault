-- Tie strategy routes and active skills to explicit strategy bots.
alter table public.arbivault_strategy_routes
  add column if not exists strategy_bot_id uuid references public.arbivault_strategy_bots(id);

alter table public.bot_skills
  add column if not exists strategy_bot_id uuid references public.arbivault_strategy_bots(id);

create index if not exists arbivault_strategy_routes_strategy_bot_idx
  on public.arbivault_strategy_routes(strategy_bot_id);

create index if not exists bot_skills_strategy_bot_idx
  on public.bot_skills(strategy_bot_id);

update public.arbivault_strategy_routes r
set strategy_bot_id = sb.id, updated_at = now()
from public.arbivault_strategy_bots sb
where r.strategy = sb.strategy;

update public.bot_skills s
set strategy_bot_id = sb.id, updated_at = now()
from public.arbivault_strategy_bots sb
where
  (lower(s.name) = 'cross-chain inventory' and sb.strategy='cross_chain_inventory')
  or (lower(s.name) = 'cross-chain' and sb.strategy='cross_chain_inventory')
  or (lower(s.name) = 'cross-chain latency' and sb.strategy='cross_chain_inventory')
  or (lower(s.name) = 'cross-dex cyclic' and sb.strategy='cross_dex_cyclic')
  or (lower(s.name) = 'dex/cex arbitrage' and sb.strategy='dex_cex_arbitrage')
  or (lower(s.name) = 'spread' and sb.strategy='dex_cex_arbitrage')
  or (lower(s.name) = 'flash loan' and sb.strategy='flash_loan_arbitrage')
  or (lower(s.name) = 'flash swap' and sb.strategy='flash_loan_arbitrage')
  or (lower(s.name) = 'liquidity fragmentation' and sb.strategy='liquidity_fragmentation')
  or (lower(s.name) = 'mev-aware route' and sb.strategy='mev_aware_arbitrage')
  or (lower(s.name) = 'orderbook microstructure' and sb.strategy='orderbook_microstructure')
  or (lower(s.name) = 'latency automation' and sb.strategy='orderbook_microstructure')
  or (lower(s.name) = 'snipe' and sb.strategy='orderbook_microstructure')
  or (lower(s.name) = 'quadra' and sb.strategy='quadra_arbitrage');
