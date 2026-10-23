-- One all-assets profit destination per flash-loan chain and owner.
-- The recipient wallet is independent from the trading hot wallet.
create unique index if not exists profit_recipient_one_all_assets_per_chain
  on public.profit_recipient_profiles(owner_id, chain)
  where asset = 'ALL' and status in ('pending', 'active');
