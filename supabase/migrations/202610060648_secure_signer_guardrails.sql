create index if not exists execution_adapters_signer_lookup_idx
  on public.execution_adapters (configured, signer_provider, automatic_signing, signing_boundary, chain);

create index if not exists signing_requests_source_wallet_status_idx
  on public.signing_requests (source_wallet_id, status, created_at desc);

create index if not exists transfer_authorizations_destination_status_idx
  on public.transfer_authorizations (destination_address, authorization_status, expires_at);

create index if not exists approved_wallets_address_status_idx
  on public.approved_wallets (address, status, chain);

comment on column public.execution_adapters.signer_provider is
  'Signer provider identifier. Production signing uses a remote HSM/TEE provider; never store private keys here.';

comment on column public.execution_adapters.signer_key_ref is
  'Public wallet/account address or provider key reference used for signing. Never store private key material.';

comment on column public.execution_adapters.automatic_signing is
  'When true, automated signing may be requested only after all adapter, wallet, policy, and destination guardrails pass.';

comment on table public.signing_requests is
  'Audit trail for signing authorization. Private key material must never be stored in this table.';
