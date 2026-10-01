-- Additive ArbiVault capability restoration. No secrets or private keys are stored in public tables.

alter table public.wallets add column if not exists is_hot boolean not null default false;
alter table public.wallets add column if not exists custody_type text not null default 'external';
alter table public.wallets add column if not exists derivation_path text;

alter table public.approved_wallets add column if not exists activation_at timestamptz;
alter table public.approved_wallets add column if not exists is_primary boolean not null default false;
update public.approved_wallets
set activation_at = coalesce(activation_at, approved_at, created_at + interval '24 hours')
where activation_at is null;

create unique index if not exists wallets_one_active_hot_per_chain
  on public.wallets(owner_id, chain)
  where is_hot = true and status not in ('disabled','quarantined');
create unique index if not exists approved_wallets_one_primary_per_chain
  on public.approved_wallets(owner_id, chain)
  where status = 'approved' and is_primary = true;

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  bot_config_id uuid references public.bot_configs(id) on delete set null,
  bot_skill_id uuid,
  chain text not null,
  strategy text not null,
  pair text,
  borrowed_amount numeric,
  notional_amount numeric,
  gross_profit numeric,
  fees_paid numeric,
  net_profit numeric not null,
  execution_time_ms numeric,
  status text not null default 'simulated' check(status in ('simulated','executed','reverted','failed')),
  execution_mode text not null default 'simulated' check(execution_mode in ('simulated','on_chain')),
  tx_hash text,
  explorer_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trades_owner_created_idx on public.trades(owner_id, created_at desc);
create index if not exists trades_tx_hash_idx on public.trades(tx_hash) where tx_hash is not null;
alter table public.trades enable row level security;
drop policy if exists trades_owner_select on public.trades;
drop policy if exists trades_owner_insert on public.trades;
drop policy if exists trades_owner_update on public.trades;
drop policy if exists trades_owner_delete on public.trades;
create policy trades_owner_select on public.trades for select to authenticated using((select auth.uid())=owner_id);
create policy trades_owner_insert on public.trades for insert to authenticated with check((select auth.uid())=owner_id and ((execution_mode='simulated' and tx_hash is null) or (execution_mode='on_chain' and tx_hash is not null)));
create policy trades_owner_update on public.trades for update to authenticated using((select auth.uid())=owner_id) with check((select auth.uid())=owner_id);
create policy trades_owner_delete on public.trades for delete to authenticated using((select auth.uid())=owner_id);

create table if not exists public.bot_skills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  bot_config_id uuid references public.bot_configs(id) on delete set null,
  name text not null,
  description text,
  active boolean not null default true,
  conditions jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  risk_limits jsonb not null default '{}'::jsonb,
  cooldown_seconds integer not null default 30 check(cooldown_seconds>=0),
  backtest jsonb,
  execution_count bigint not null default 0,
  last_executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bot_skills_owner_idx on public.bot_skills(owner_id);
alter table public.bot_skills enable row level security;
drop policy if exists bot_skills_owner_all on public.bot_skills;
create policy bot_skills_owner_all on public.bot_skills for all to authenticated using((select auth.uid())=owner_id) with check((select auth.uid())=owner_id);

create table if not exists public.bot_wallet_bindings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  bot_config_id uuid not null references public.bot_configs(id) on delete cascade,
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  role text not null default 'execution' check(role in ('execution','reserve')),
  created_at timestamptz not null default now(),
  unique(bot_config_id,wallet_id,role)
);
alter table public.bot_wallet_bindings enable row level security;
drop policy if exists bot_wallet_bindings_owner_all on public.bot_wallet_bindings;
create policy bot_wallet_bindings_owner_all on public.bot_wallet_bindings for all to authenticated using((select auth.uid())=owner_id) with check((select auth.uid())=owner_id);
