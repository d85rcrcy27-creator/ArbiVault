-- Keep signer adapter types aligned with the chain-specific execution pipeline.
-- This migration intentionally does not enable signing or broadcasting.
alter table public.execution_adapters
  drop constraint if exists execution_adapters_adapter_type_check;

alter table public.execution_adapters
  add constraint execution_adapters_adapter_type_check
  check (adapter_type = any (array[
    'evm_flash_atomic'::text,
    'cex'::text,
    'dex_router'::text,
    'custom'::text,
    'solana_program'::text,
    'bitcoin_psbt'::text
  ]));

update public.execution_adapters ea
set adapter_type = case ea.chain
      when 'bitcoin' then 'bitcoin_psbt'
      when 'solana' then 'solana_program'
      else 'dex_router'
    end,
    allowed_wallet_id = w.id,
    signer_key_ref = w.address,
    updated_at = now()
from public.wallets w
where w.chain = ea.chain
  and w.status = 'active'
  and w.is_hot = true
  and w.wallet_role = 'trading_hot'
  and w.data_quality_status = 'verified'
  and w.secret_ref is not null
  and ea.chain in ('bitcoin','bnb','ethereum','solana')
  and (ea.allowed_wallet_id is distinct from w.id
       or ea.signer_key_ref is distinct from w.address
       or ea.adapter_type is distinct from case ea.chain
          when 'bitcoin' then 'bitcoin_psbt'
          when 'solana' then 'solana_program'
          else 'dex_router'
       end);

update public.arbivault_strategy_wallets sw
set wallet_id = w.id,
    status = 'assigned',
    updated_at = now()
from public.wallets w
where w.chain = sw.chain
  and w.owner_id = sw.owner_id
  and w.status = 'active'
  and w.is_hot = true
  and w.wallet_role = 'trading_hot'
  and w.data_quality_status = 'verified'
  and w.secret_ref is not null
  and (sw.wallet_id is null
       or not exists (
         select 1 from public.wallets current_wallet
         where current_wallet.id = sw.wallet_id
           and current_wallet.status = 'active'
           and current_wallet.data_quality_status = 'verified'
           and current_wallet.secret_ref is not null
           and current_wallet.chain = sw.chain
       ));
