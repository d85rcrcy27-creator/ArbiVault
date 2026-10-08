-- Remove stale adapter placeholders that were never executable and have no execution references.
-- Keep the configured, bound internal-vault signers only.
delete from public.execution_adapters ea
where ea.configured = false
  and ea.can_broadcast = false
  and ea.allowed_wallet_id is null
  and (
    ea.name ilike 'Turnkey % Trading Signer'
    or ea.health_status in ('unconfigured','offline')
  )
  and not exists (
    select 1
    from public.execution_attempts a
    where a.adapter_id = ea.id
  );

-- Remove the unused non-automatic duplicate Bitcoin signer.
delete from public.execution_adapters ea
where ea.chain = 'bitcoin'
  and ea.automatic_signing = false
  and ea.signer_provider = 'internal_vault'
  and ea.can_broadcast = true
  and not exists (
    select 1
    from public.execution_attempts a
    where a.adapter_id = ea.id
  );