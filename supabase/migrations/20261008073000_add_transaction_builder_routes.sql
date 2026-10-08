-- accepted transaction-builder capabilities
alter table public.arbivault_strategy_routes
  add column if not exists transaction_builder text,
  add column if not exists builder_enabled boolean not null default false,
  add column if not exists builder_status text not null default 'unconfigured';

create index if not exists arbivault_strategy_routes_builder_idx
  on public.arbivault_strategy_routes(builder_enabled, transaction_builder);

update public.arbivault_strategy_routes
set transaction_builder = null,
    builder_enabled = false,
    builder_status = 'unconfigured'
where route_type not in ('dex_cex','cyclic','multi_venue');

update public.arbivault_strategy_routes
set transaction_builder = case
      when chain = 'solana' and dex_venue = 'Jupiter' then 'jupiter_swap_v2'
      when chain = 'bnb' and dex_venue = 'PancakeSwap' then 'pancakeswap_v2'
      else null
    end,
    builder_enabled = case
      when chain = 'solana' and dex_venue = 'Jupiter' then true
      when chain = 'bnb' and dex_venue = 'PancakeSwap' then true
      else false
    end,
    builder_status = case
      when chain in ('solana','bnb') and dex_venue in ('Jupiter','PancakeSwap') then 'configured_unsigned'
      else 'unconfigured'
    end
where route_type in ('dex_cex','cyclic','multi_venue');

update public.execution_adapters
set allowed_contracts = '[\"0x10ED43C718714eb63d5aA57B78B54704E256024E\"]'::jsonb
where id = '4a5aacd6-82e7-4e36-9ada-5dd7e02efe47'
  and signer_provider = 'internal_vault'
  and signing_boundary = 'internal_vault';
