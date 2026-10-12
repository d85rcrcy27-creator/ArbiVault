-- AI strategy proposals are review records, not execution authority.
-- Only trusted backend services may create/update proposal and execution-proof rows.

create table if not exists public.strategy_proposals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in (
    'dex_arbitrage', 'collateral_swap', 'liquidation', 'debt_refinancing'
  )),
  title text not null check (char_length(title) between 3 and 120),
  summary text not null check (char_length(summary) between 3 and 1600),
  objective text not null check (char_length(objective) between 3 and 1200),
  strategy_config jsonb not null check (jsonb_typeof(strategy_config) = 'object'),
  risk_assessment jsonb not null default '{}'::jsonb check (jsonb_typeof(risk_assessment) = 'object'),
  status text not null default 'pending_review' check (
    status in ('pending_review', 'approved_for_preflight', 'rejected', 'archived')
  ),
  execution_status text not null default 'blocked_pending_adapters' check (
    execution_status in (
      'proposal_only', 'blocked_pending_adapters', 'preflight_ready',
      'signing_approval_required', 'submitted', 'confirmed', 'proven'
    )
  ),
  generated_by text not null default 'openai',
  model text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text check (review_notes is null or char_length(review_notes) <= 1200),
  onchain_strategy_hash text,
  registry_tx_hash text,
  proof_profitable_run_count integer not null default 0 check (proof_profitable_run_count >= 0),
  proof_net_profit_usd numeric(38, 12) not null default 0,
  proven boolean not null default false,
  proven_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    not proven or (
      proof_profitable_run_count >= 5
      and proof_net_profit_usd > 0
      and proven_at is not null
    )
  )
);

create index if not exists strategy_proposals_owner_created_idx
  on public.strategy_proposals(owner_id, created_at desc);
create index if not exists strategy_proposals_review_queue_idx
  on public.strategy_proposals(owner_id, status, created_at desc);

alter table public.strategy_proposals enable row level security;
revoke all on public.strategy_proposals from public, anon, authenticated;
grant select on public.strategy_proposals to authenticated;

drop policy if exists strategy_proposals_owner_select on public.strategy_proposals;
create policy strategy_proposals_owner_select
  on public.strategy_proposals for select to authenticated
  using ((select auth.uid()) = owner_id);

-- Proposal execution evidence is written only by trusted backend services after
-- checking a mined transaction receipt and an actual asset-balance delta.
create table if not exists public.strategy_proposal_runs (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.strategy_proposals(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  chain text not null check (chain in ('ethereum', 'bnb')),
  tx_hash text not null check (char_length(tx_hash) between 16 and 132),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'reverted')),
  net_profit_usd numeric(38, 12),
  profit_basis text not null default 'unverified_estimate' check (
    profit_basis in ('unverified_estimate', 'verified_balance_delta')
  ),
  block_number bigint,
  confirmed_at timestamptz,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain, tx_hash),
  check (status <> 'confirmed' or confirmed_at is not null),
  check (profit_basis <> 'verified_balance_delta' or (status = 'confirmed' and net_profit_usd is not null))
);

create index if not exists strategy_proposal_runs_proposal_idx
  on public.strategy_proposal_runs(proposal_id, confirmed_at desc);

alter table public.strategy_proposal_runs enable row level security;
revoke all on public.strategy_proposal_runs from public, anon, authenticated;
grant select on public.strategy_proposal_runs to authenticated;

drop policy if exists strategy_proposal_runs_owner_select on public.strategy_proposal_runs;
create policy strategy_proposal_runs_owner_select
  on public.strategy_proposal_runs for select to authenticated
  using ((select auth.uid()) = owner_id);

create or replace function public.refresh_strategy_proposal_proof_rollup()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_proposal_id uuid;
  profitable_run_count integer;
  verified_profit numeric(38, 12);
begin
  if tg_op = 'DELETE' then
    target_proposal_id := old.proposal_id;
  else
    target_proposal_id := new.proposal_id;
  end if;

  select count(*)::integer, coalesce(sum(r.net_profit_usd), 0)
    into profitable_run_count, verified_profit
  from public.strategy_proposal_runs r
  where r.proposal_id = target_proposal_id
    and r.status = 'confirmed'
    and r.profit_basis = 'verified_balance_delta'
    and r.net_profit_usd > 0;

  update public.strategy_proposals p
  set proof_profitable_run_count = profitable_run_count,
      proof_net_profit_usd = verified_profit,
      proven = (profitable_run_count >= 5 and verified_profit > 0 and p.status <> 'rejected'),
      proven_at = case
        when profitable_run_count >= 5 and verified_profit > 0 and p.status <> 'rejected'
          then coalesce(p.proven_at, now())
        else null
      end,
      execution_status = case
        when profitable_run_count >= 5 and verified_profit > 0 and p.status <> 'rejected'
          then 'proven'
        else p.execution_status
      end,
      updated_at = now()
  where p.id = target_proposal_id;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.refresh_strategy_proposal_proof_rollup() from public, anon, authenticated;

drop trigger if exists strategy_proposal_proof_rollup on public.strategy_proposal_runs;
create trigger strategy_proposal_proof_rollup
after insert or update of status, net_profit_usd, profit_basis or delete
on public.strategy_proposal_runs
for each row execute function public.refresh_strategy_proposal_proof_rollup();

-- Do not expose privileged mutation through the client Data API.
notify pgrst, 'reload schema';
