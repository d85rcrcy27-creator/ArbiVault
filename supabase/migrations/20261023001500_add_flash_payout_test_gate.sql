alter table public.arbivault_strategy_routes
  add column if not exists payout_test_authorized boolean not null default false,
  add column if not exists payout_test_authorized_by uuid,
  add column if not exists payout_test_authorized_at timestamptz,
  add column if not exists payout_test_used_at timestamptz,
  add column if not exists payout_test_execution_attempt_id uuid,
  add column if not exists payout_test_tx_hash text;

comment on column public.arbivault_strategy_routes.payout_test_authorized is
  'One-shot, human-authorized payout verification only. Does not enable the route for autonomous trading.';
comment on column public.arbivault_strategy_routes.payout_test_used_at is
  'Claim timestamp for the single authorized payout test attempt. A new explicit authorization is required after this is set.';
comment on column public.arbivault_strategy_routes.payout_test_execution_attempt_id is
  'The only execution attempt permitted to use discovery-only builder/signer exceptions for payout verification.';
comment on column public.arbivault_strategy_routes.payout_test_tx_hash is
  'Confirmed mainnet transaction hash used to prove that the executor paid the configured wallet.';
notify pgrst, 'reload schema';
