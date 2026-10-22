begin;

alter table public.execution_attempts
  add column if not exists estimated_network_fee_usd numeric,
  add column if not exists network_fee_usd numeric,
  add column if not exists flash_loan_fee_usd numeric,
  add column if not exists x402_resource_fee_usd numeric not null default 0,
  add column if not exists pnl_currency text not null default 'USD',
  add column if not exists fee_breakdown jsonb not null default '{}'::jsonb;

alter table public.trades
  add column if not exists estimated_network_fee_usd numeric,
  add column if not exists network_fee_usd numeric,
  add column if not exists flash_loan_fee_usd numeric,
  add column if not exists x402_resource_fee_usd numeric not null default 0,
  add column if not exists pnl_currency text not null default 'USD',
  add column if not exists fee_breakdown jsonb not null default '{}'::jsonb;

-- Unknown P&L must remain NULL rather than being represented as fake zero profit.
alter table public.trades alter column net_profit drop not null;

comment on column public.execution_attempts.gas_fee is
  'Actual paid fee in the native gas asset (BNB, ETH, SOL, or BTC); not USD.';
comment on column public.execution_attempts.network_fee_usd is
  'USD-equivalent valuation of the actual network fee when known; NULL when not safely valued.';
comment on column public.execution_attempts.estimated_network_fee_usd is
  'Preflight network-fee estimate in USD-equivalent terms; kept distinct from actual native gas.';
comment on column public.execution_attempts.x402_resource_fee_usd is
  'Only the explicitly attributed paid x402 resource charge for this attempt; free previews are zero.';
comment on column public.trades.fees_paid is
  'Total fees in pnl_currency (USD by default), not a native-token amount.';
comment on column public.trades.net_profit is
  'Gross profit less flash-loan premium, USD-valued network fee, and attributed paid x402 resource fee; NULL if inputs are unknown.';

notify pgrst, 'reload schema';
commit;