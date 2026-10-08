-- Trade confirmations do not require an approved withdrawal destination.
-- Withdrawal/transfer/payment settlement still does.
create or replace function public.enforce_wallet_activation_gate()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare approved_status text;
begin
  if new.transaction_class <> 'trade' and new.status in ('activated','broadcast','confirmed') then
    if new.approved_wallet_id is null then
      raise exception 'WALLET_APPROVAL_GATE: approved_wallet_id required before activation';
    end if;
    select status into approved_status
    from public.approved_wallets
    where id=new.approved_wallet_id;
    if approved_status is distinct from 'approved' then
      raise exception 'WALLET_APPROVAL_GATE: referenced wallet is not approved';
    end if;
  end if;
  return new;
end;
$$;

-- Confirmation worker can call this later if desired; current worker performs
-- the same idempotent settlement directly using the service role.
create or replace function public.settle_confirmed_execution_trade(
  p_execution_attempt_id uuid,
  p_tx_hash text,
  p_confirmed_at timestamptz,
  p_fee_amount numeric default null,
  p_fee_asset text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.trades
language plpgsql
security definer
set search_path=public
as $$
declare
  ea record;
  sr record;
  t public.trades;
  skill_id uuid;
  existing_id uuid;
  bot_config_id uuid;
begin
  if p_execution_attempt_id is null or nullif(trim(p_tx_hash),'') is null or p_confirmed_at is null then
    raise exception 'execution settlement requires attempt, tx hash and confirmed_at';
  end if;

  select * into ea from public.execution_attempts where id=p_execution_attempt_id for update;
  if ea.id is null then raise exception 'execution_attempt_not_found'; end if;
  if ea.status not in ('broadcast','validated','confirmed') then raise exception 'execution_attempt_not_settleable'; end if;

  select id into skill_id
  from public.bot_skills
  where strategy_bot_id=ea.strategy_bot_id
  order by created_at desc limit 1;

  select id into bot_config_id
  from public.bot_configs
  where owner_id=ea.owner_id and bot_role='execution'
  order by created_at asc limit 1;

  select id into existing_id
  from public.trades
  where owner_id=ea.owner_id and tx_hash=p_tx_hash
  order by created_at desc limit 1;

  if existing_id is null then
    insert into public.trades(
      owner_id,bot_config_id,bot_skill_id,chain,strategy,pair,
      notional_amount,borrowed_amount,gross_profit,fees_paid,net_profit,
      status,execution_mode,tx_hash,explorer_url,metadata,confirmed_at,
      wallet_id,execution_attempt_id,wallet_transaction_id
    )
    values(
      ea.owner_id,bot_config_id,skill_id,ea.chain,
      coalesce(p_metadata->>'strategy','on_chain_execution'),
      nullif(p_metadata->>'pair',''),
      ea.capital_used,null,coalesce(ea.gross_profit,0),coalesce(p_fee_amount,ea.gas_fee,0),
      coalesce(ea.net_profit,0),'executed','on_chain',p_tx_hash,
      case ea.chain
        when 'bnb' then 'https://bscscan.com/tx/'||p_tx_hash
        when 'solana' then 'https://solscan.io/tx/'||p_tx_hash
        when 'bitcoin' then 'https://mempool.space/tx/'||p_tx_hash
        else null
      end,
      coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object(
        'confirmation_source','arbivault-execution-confirm',
        'pnl_basis','realized_only'
      ),
      p_confirmed_at,ea.wallet_id,ea.id,null
    )
    returning * into t;
  else
    update public.trades
    set status='executed',
        confirmed_at=p_confirmed_at,
        fees_paid=coalesce(p_fee_amount,ea.gas_fee,fees_paid),
        gross_profit=coalesce(ea.gross_profit,gross_profit),
        net_profit=coalesce(ea.net_profit,net_profit),
        execution_attempt_id=ea.id,
        wallet_id=coalesce(ea.wallet_id,wallet_id),
        updated_at=now()
    where id=existing_id
    returning * into t;
  end if;

  update public.execution_attempts
  set status='confirmed',
      tx_hash=p_tx_hash,
      confirmed_at=p_confirmed_at,
      gas_fee=coalesce(p_fee_amount,gas_fee),
      updated_at=now(),
      failure_reason=null
  where id=ea.id;

  select * into sr from public.signing_requests
  where execution_attempt_id=ea.id and tx_hash=p_tx_hash
  order by created_at desc limit 1;

  if sr.id is not null then
    update public.signing_requests
    set status='confirmed', confirmed_at=p_confirmed_at, updated_at=now()
    where id=sr.id;
  end if;

  return t;
end;
$$;

revoke all on function public.settle_confirmed_execution_trade(uuid,text,timestamptz,numeric,text,jsonb) from public;
grant execute on function public.settle_confirmed_execution_trade(uuid,text,timestamptz,numeric,text,jsonb) to service_role;
