-- Base44 -> Supabase entity reconciliation for ArbiVault.
-- No private keys or secrets belong in these tables or in the Vite client.

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  created_by_id uuid not null references auth.users(id) on delete cascade,
  chain text not null check (chain in ('solana','bnb','bitcoin')),
  address text not null,
  label text,
  balance numeric not null default 0,
  native_balance numeric not null default 0,
  status text not null default 'active' check (status in ('active','paused','generating')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.approved_wallets (
  id uuid primary key default gen_random_uuid(),
  created_by_id uuid not null references auth.users(id) on delete cascade,
  chain text not null check (chain in ('solana','bnb','bitcoin')),
  address text not null, label text,
  status text not null default 'pending' check (status in ('pending','active')),
  activation_date timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.transfers (
  id uuid primary key default gen_random_uuid(),
  created_by_id uuid not null references auth.users(id) on delete cascade,
  from_wallet_id uuid references public.wallets(id) on delete set null,
  from_address text not null, to_address text not null,
  chain text not null check (chain in ('solana','bnb','bitcoin')),
  amount numeric not null, txid text,
  status text not null default 'pending' check (status in ('pending','confirmed','failed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  created_by_id uuid not null references auth.users(id) on delete cascade,
  chain text not null check (chain in ('solana','bnb','bitcoin')),
  strategy text not null check (strategy in ('flash_loan','flash_swap','mempool_sandwich','liquidity_fragmentation','cross_chain_latency')),
  pair text, borrowed_amount numeric, gross_profit numeric, fees_paid numeric,
  net_profit numeric not null, execution_time_ms numeric,
  status text not null default 'executed' check (status in ('executed','reverted','failed')),
  txid text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.bot_configs (
  id uuid primary key default gen_random_uuid(),
  created_by_id uuid not null references auth.users(id) on delete cascade,
  chain text not null check (chain in ('solana','bnb','bitcoin')),
  strategy text not null check (strategy in ('flash_loan','flash_swap','mempool_sandwich','liquidity_fragmentation','cross_chain_latency','global')),
  enabled boolean not null default false,
  min_profit_threshold numeric not null default 0.5, max_gas_budget numeric not null default 0.01,
  slippage_tolerance numeric not null default 1.0, max_trade_size numeric not null default 10000,
  opportunities_detected numeric not null default 0, opportunities_executed numeric not null default 0,
  opportunities_skipped numeric not null default 0, last_scan timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  created_by_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('auth','trade','transfer','config_change','emergency_stop','wallet_added','wallet_removed','bot_pause','bot_resume','security_lockout','bottleneck')),
  description text not null, details text, created_at timestamptz not null default now()
);

create table if not exists public.balance_reconciliations (
  id uuid primary key default gen_random_uuid(),
  created_by_id uuid not null references auth.users(id) on delete cascade,
  run_at timestamptz not null,
  status text not null check (status in ('pending_verification','reconciled','blocked')),
  wallet_count numeric not null, trade_count numeric not null, transfer_count numeric not null,
  chains_checked text not null, authoritative_source text not null, variance_notes text not null,
  action_required text not null, created_at timestamptz not null default now()
);

create index if not exists wallets_created_by_id_idx on public.wallets(created_by_id);
create index if not exists approved_wallets_created_by_id_idx on public.approved_wallets(created_by_id);
create index if not exists transfers_created_by_id_idx on public.transfers(created_by_id);
create index if not exists trades_created_by_id_idx on public.trades(created_by_id);
create index if not exists bot_configs_created_by_id_idx on public.bot_configs(created_by_id);
create index if not exists audit_logs_created_by_id_idx on public.audit_logs(created_by_id);
create index if not exists balance_reconciliations_created_by_id_idx on public.balance_reconciliations(created_by_id);

alter table public.wallets enable row level security;
alter table public.approved_wallets enable row level security;
alter table public.transfers enable row level security;
alter table public.trades enable row level security;
alter table public.bot_configs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.balance_reconciliations enable row level security;

-- Supabase replacement for Base44 created_by_id + admin rules. Admin is read
-- from app_metadata, never user-editable user_metadata.
do $$
declare t text; p text;
begin
  foreach t in array array['wallets','approved_wallets','transfers','trades','bot_configs','audit_logs','balance_reconciliations'] loop
    p := t || '_select_owner_or_admin';
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = created_by_id or (select coalesce(auth.jwt()->''app_metadata''->>''role'' = ''admin'', false)))', p, t);
    p := t || '_insert_owner';
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = created_by_id)', p, t);
    p := t || '_update_owner_or_admin';
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = created_by_id or (select coalesce(auth.jwt()->''app_metadata''->>''role'' = ''admin'', false))) with check ((select auth.uid()) = created_by_id or (select coalesce(auth.jwt()->''app_metadata''->>''role'' = ''admin'', false)))', p, t);
    p := t || '_delete_owner_or_admin';
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = created_by_id or (select coalesce(auth.jwt()->''app_metadata''->>''role'' = ''admin'', false)))', p, t);
  end loop;
end $$;
