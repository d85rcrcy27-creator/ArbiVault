-- Remove the stale adapter placeholders that were never executable.
-- These exact placeholder names are not used by the current internal-vault signer.
delete from public.execution_adapters ea
where ea.name in (
  'Turnkey BNB Trading Signer',
  'Turnkey Solana Trading Signer',
  'Turnkey EVM Trading Signer',
  'ArbiVault Internal Vault ETHEREUM Trading Signer'
)
and ea.configured = false
and ea.can_broadcast = false
and ea.allowed_wallet_id is null
and not exists (
  select 1
  from public.execution_attempts a
  where a.adapter_id = ea.id
);

-- Remove the unused non-automatic duplicate Bitcoin signer.
delete from public.execution_adapters ea
where ea.name = 'ArbiVault Internal Vault Bitcoin Trading Signer'
  and ea.chain = 'bitcoin'
  and ea.automatic_signing = false
  and ea.can_broadcast = true
  and not exists (
    select 1
    from public.execution_attempts a
    where a.adapter_id = ea.id
  );