-- Make the adapter catalog accurately describe chain-specific signing families.
-- Keep all adapters non-broadcasting until wallet provenance, approval, allowlists,
-- and the corresponding protocol integration have been verified.
alter table public.execution_adapters
  drop constraint if exists execution_adapters_adapter_type_check;
alter table public.execution_adapters
  add constraint execution_adapters_adapter_type_check
  check (adapter_type = any (array[
    'evm_flash_atomic',
    'cex',
    'dex_router',
    'custom',
    'solana_program',
    'bitcoin_psbt',
    'safe_multisig'
  ]::text[]));

alter table public.execution_adapters
  drop constraint if exists execution_adapters_signing_boundary_check;
alter table public.execution_adapters
  add constraint execution_adapters_signing_boundary_check
  check (signing_boundary = any (array[
    'external_signer',
    'hsm',
    'kms',
    'custodial',
    'internal_vault',
    'turnkey',
    'safe'
  ]::text[]));

update public.execution_adapters
set configured = false,
    automatic_signing = false,
    can_broadcast = false,
    read_only = true,
    health_status = 'unconfigured',
    last_error = 'awaiting_verified_wallet_and_protocol_allowlist',
    updated_at = now()
where configured = true
   or automatic_signing = true
   or can_broadcast = true
   or read_only = false;

update public.execution_adapters
set adapter_type = 'solana_program',
    updated_at = now()
where chain = 'solana'
  and adapter_type = 'dex_router';

update public.execution_adapters
set adapter_type = 'bitcoin_psbt',
    updated_at = now()
where chain = 'bitcoin'
  and adapter_type = 'dex_router';
