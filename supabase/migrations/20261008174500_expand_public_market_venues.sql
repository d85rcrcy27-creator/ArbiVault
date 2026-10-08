-- Expand the public market venue catalog. These adapters are read-only research inputs;
-- they do not authorize order placement, signing, withdrawals, or broadcast.
insert into public.arbivault_market_adapters
  (name, venue_type, base_url, public_api, private_auth_required, enabled, read_only, chains)
select 'Binance Public Market Data', 'cex', 'https://api.binance.com', true, false, true, true,
       array['ethereum','bitcoin','solana','bnb']
where not exists (
  select 1 from public.arbivault_market_adapters where name='Binance Public Market Data'
);

insert into public.arbivault_market_adapters
  (name, venue_type, base_url, public_api, private_auth_required, enabled, read_only, chains)
select 'Bybit Public Market Data', 'cex', 'https://api.bybit.com', true, false, true, true,
       array['ethereum','bitcoin','solana','bnb']
where not exists (
  select 1 from public.arbivault_market_adapters where name='Bybit Public Market Data'
);

insert into public.arbivault_market_adapters
  (name, venue_type, base_url, public_api, private_auth_required, enabled, read_only, chains)
select 'OKX Public Market Data', 'cex', 'https://www.okx.com', true, false, true, true,
       array['ethereum','bitcoin','solana','bnb']
where not exists (
  select 1 from public.arbivault_market_adapters where name='OKX Public Market Data'
);

-- Keep every public adapter strictly read-only.
update public.arbivault_market_adapters
set enabled=true, read_only=true, updated_at=now()
where public_api=true;
