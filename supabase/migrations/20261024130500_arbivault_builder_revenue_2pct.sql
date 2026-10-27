-- ArbiVault builder revenue policy: accrue a variable fee only after a confirmed,
-- successful atomic flash-loan settlement and only from positive verified net profit. This ledger is accounting only;
-- collection remains disabled until an audited on-chain fee recipient path exists.
create table if not exists public.arbivault_builder_fee_ledger (
  id uuid primary key default gen_random_uuid(),
  execution_attempt_id uuid not null references public.execution_attempts(id) on delete restrict,
  chain text not null check (chain in ('bnb','ethereum')),
  tx_hash text not null,
  route_id uuid null,
  settlement_asset text not null,
  settled_amount_raw numeric(78,0) not null check (settled_amount_raw > 0),
  eligible_transaction_value_usd numeric(38,12) not null check (eligible_transaction_value_usd > 0),
  fee_rate numeric(6,5) not null default 0.10000 check (fee_rate = 0.10000),
  fee_due_usd numeric(38,12) not null check (fee_due_usd >= 0),
  fee_basis text not null default '10_percent_of_verified_positive_net_profit_capped_at_0.25_percent_of_settled_principal',
  verified_net_profit_usd numeric(38,12) not null check (verified_net_profit_usd > 0),
  settlement_status text not null default 'confirmed',
  collection_status text not null default 'accrued_not_collected'
    check (collection_status in ('accrued_not_collected','collected','waived','failed')),
  settlement_block text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain, tx_hash)
);

create index if not exists arbivault_builder_fee_ledger_attempt_idx
  on public.arbivault_builder_fee_ledger (execution_attempt_id);
create index if not exists arbivault_builder_fee_ledger_collection_idx
  on public.arbivault_builder_fee_ledger (collection_status, created_at);

alter table public.arbivault_builder_fee_ledger enable row level security;
revoke all on public.arbivault_builder_fee_ledger from anon, authenticated;
grant select, insert, update on public.arbivault_builder_fee_ledger to service_role;

comment on table public.arbivault_builder_fee_ledger is
  'Idempotent accounting ledger for a variable ArbiVault atomic builder fee: 10% of verified positive net profit, capped at 0.25% of settled principal. Rows are accrued only after successful on-chain settlement; this does not itself transfer funds.';
